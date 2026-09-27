/* SPDX-License-Identifier: MIT */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "bootcamp_config.h"
#include "depth_view.h"
#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "i2c_bus_recover.h"
#include "pico/stdio.h"
#include "pico/stdio_usb.h"
#include "pico/stdlib.h"
#include "vl53l8cx_api.h"

/** @brief GPIO 番号からピンマスク(その番号のビットだけ 1 の値)を作る。 */
#define PIN_BIT(pin) (1u << (pin))

/** @brief RGB LED の3色。アクティブ Low なので H が消灯。 */
#define LED_MASK (PIN_BIT(BOOTCAMP_PIN_LED_RED) | PIN_BIT(BOOTCAMP_PIN_LED_GREEN) | PIN_BIT(BOOTCAMP_PIN_LED_BLUE))

/* 解像度の設定が ULD の受け付ける値(4x4 / 8x8)で、depth_view の上限にも収まること */
_Static_assert(BOOTCAMP_RESOLUTION == VL53L8CX_RESOLUTION_4X4 || BOOTCAMP_RESOLUTION == VL53L8CX_RESOLUTION_8X8,
               "BOOTCAMP_ZONE_SIDE must be 4 or 8");
_Static_assert(BOOTCAMP_ZONE_SIDE <= DEPTH_VIEW_MAX_SIDE, "BOOTCAMP_ZONE_SIDE exceeds DEPTH_VIEW_MAX_SIDE");
/* depth_view には ULD の結果の配列をそのまま渡し、添字をゾーン番号として扱う。1 ゾーン 1 ターゲットが前提 */
_Static_assert(VL53L8CX_NB_TARGET_PER_ZONE == 1u, "depth_view expects one target per zone");

/** @brief フレームレートを求めるのに使う直近のフレーム数(この数の間隔の合計時間から計算する)。 */
#define FPS_WINDOW 15u

/** @brief 画面全体を消す ANSI エスケープ(ESC [ 2 J)。カラー表示の開始時に使う。 */
#define ANSI_CLEAR_SCREEN "\x1b[2J"
/** @brief カーソルを左上へ移す ANSI エスケープ(ESC [ H)。 */
#define ANSI_HOME "\x1b[H"
/** @brief カーソル位置から行末までを消す ANSI エスケープ(ESC [ K)。 */
#define ANSI_CLEAR_EOL "\x1b[K"
/** @brief カーソル位置から画面の最後までを消す ANSI エスケープ(ESC [ J)。 */
#define ANSI_CLEAR_BELOW "\x1b[J"
/** @brief 文字の色・背景色を既定に戻す ANSI エスケープ(ESC [ 0 m)。 */
#define ANSI_RESET "\x1b[0m"

/**
 * @brief ULD のセンサー設定(約 2.3 KB。内部の一時バッファを含む)。スタックに置かないように静的領域に置く。
 *
 * platform メンバーは main() で埋める。それ以外は ULD が管理する。
 */
static VL53L8CX_Configuration dev;

/** @brief 1 フレームぶんの測距結果。dev と同じ理由で静的領域に置く。 */
static VL53L8CX_ResultsData results;

/** @brief 距離画像の文字列の組み立て先(約 3.3 KB。depth_view_render() が必要とする大きさ)。 */
static char frame_text[DEPTH_VIEW_RENDER_BUF_SIZE];

/** @brief 表示の設定(キー操作で変わる)。 */
static depth_view_options_t view = {
    BOOTCAMP_FLIP_H_DEFAULT, BOOTCAMP_FLIP_V_DEFAULT, BOOTCAMP_COLOR_DEFAULT,
    BOOTCAMP_SIGMA_MAX_MM,   BOOTCAMP_RANGE_MAX_MM,
};

/** @brief 次のカラー描画の前に画面全体を消すか(起動後最初の描画、カラーへの切り替え、ヘルプ表示の後に立てる)。 */
static bool clear_before_draw = true;

/** @brief ヘルプの表示中、距離画像の描画を再開する時刻。これより前は描画しない。 */
static absolute_time_t help_hold_until;

/** @brief ステータス行の組み立て先。 */
static char status_text[DEPTH_VIEW_STATUS_BUF_SIZE];

/**
 * @brief 直近のフレームのデータ準備を検出した時刻 [µs](リングバッファ)。FPS_WINDOW 個の間隔を得るため 1 個多く持つ。
 */
static uint64_t frame_times[FPS_WINDOW + 1u];

/** @brief frame_times に入っている時刻の数(最大 FPS_WINDOW + 1)。 */
static uint32_t frame_times_count;

/** @brief frame_times の次に書く位置。 */
static uint32_t frame_times_next;

/** @brief vl53l8cx_check_data_ready() のエラーの累計。 */
static uint32_t ready_errors;

/** @brief vl53l8cx_get_ranging_data() のエラーの累計。 */
static uint32_t data_errors;

/**
 * @brief RGB LED の3色を消灯した状態で出力に設定する。
 *
 * gpio_init_mask は指定したピンを SIO(CPU が直接読み書きする機能)に割り当て、入力・出力値 L に初期化する。
 * 値を先に H(消灯)にしてから出力方向にするので、切り替えの瞬間に LED が点かない。
 */
static void leds_init(void) {
  gpio_init_mask(LED_MASK);
  gpio_put_masked(LED_MASK, LED_MASK);
  gpio_set_dir_out_masked(LED_MASK);
}

/**
 * @brief LED を 1 色点灯・消灯する(アクティブ Low なので on で L を出す)。
 * @param pin LED の GPIO 番号
 * @param on 点灯するなら true
 */
static void led_set(uint pin, bool on) {
  gpio_put(pin, !on);
}

/**
 * @brief センサーの LPn / INT のピンを初期化し、I2C バスを復旧してから I2C1 を初期化する。
 *
 * RP2040 の GPIO はリセット直後に内蔵プルダウンが有効になっている(PADS_BANK0 の PDE のリセット値が 1)。
 * gpio_set_function はプルアップ・プルダウンを変えないので(SDK の gpio.c で確認)、gpio_disable_pulls で外す。
 * SDA / SCL / INT / LPn はキャリア基板上でプルアップ済みなので、内蔵のプルアップは使わない。
 * @param recover バス復旧の結果の格納先
 * @return i2c_init が設定した実際のクロック [Hz]
 */
static uint sensor_pins_init(i2c_bus_recover_result_t *recover) {
  /* LPn は H(I2C 通信を有効)を出す。値を先に書いてから出力方向にする。バス復旧でセンサーにクロックを受け取らせる
     ために、復旧より前に H にしておく */
  gpio_init(BOOTCAMP_PIN_LPN);
  gpio_disable_pulls(BOOTCAMP_PIN_LPN);
  gpio_put(BOOTCAMP_PIN_LPN, true);
  gpio_set_dir(BOOTCAMP_PIN_LPN, GPIO_OUT);

  /* INT は入力(Step 2 まででは読まない)。gpio_init は SIO の入力にする */
  gpio_init(BOOTCAMP_PIN_INT);
  gpio_disable_pulls(BOOTCAMP_PIN_INT);

  /* 測距中(センサーからの読み出しの途中)に MCU だけがリセットされると、センサーが SDA を Low に保持したままに
     なりうる。SDK の I2C 関数はタイムアウトしても abort も STOP もしない(i2c.c)ので、このまま I2C1 を使い始めると
     is_alive で失敗し続ける。I2C1 に切り替える前に、GPIO でバスを復旧しておく */
  *recover = i2c_bus_recover(BOOTCAMP_PIN_SDA, BOOTCAMP_PIN_SCL);

  /* i2c_init は I2C ブロックをリセットして、マスターモード・指定クロックに設定する。戻り値は分周の都合で
     実際に設定できたクロック */
  const uint actual_hz = i2c_init(i2c1, BOOTCAMP_I2C_BAUDRATE_HZ);
  gpio_set_function(BOOTCAMP_PIN_SDA, GPIO_FUNC_I2C);
  gpio_set_function(BOOTCAMP_PIN_SCL, GPIO_FUNC_I2C);
  gpio_disable_pulls(BOOTCAMP_PIN_SDA);
  gpio_disable_pulls(BOOTCAMP_PIN_SCL);

  return actual_hz;
}

/**
 * @brief USB CDC でターミナルが接続されるのを、最大 BOOTCAMP_USB_WAIT_MS 待つ。
 *
 * stdio_usb_connected は、既定の設定では CDC の DTR(ターミナルがポートを開いたときに立つ信号)を見る
 * (SDK の stdio_usb.c で確認)。接続されなくても時間が来たら先へ進む(その間の出力は捨てられる)。
 */
static void wait_usb_terminal(void) {
  const absolute_time_t deadline = make_timeout_time_ms(BOOTCAMP_USB_WAIT_MS);
  while (!stdio_usb_connected() && !time_reached(deadline)) sleep_ms(10);
}

/**
 * @brief 失敗を表示して止まる。赤 LED を点け、失敗内容を一定間隔で表示し続ける(後からターミナルを開いても見られる)。
 * @param step 失敗した処理の名前
 * @param status ULD の関数が返したステータス
 */
static void fail_forever(const char *step, uint8_t status) {
  /* 緑を消して赤を点ける。gpio_put_masked は mask のピンだけを 1 回のレジスタ書き込みで変える(アクティブ Low なので
     赤 = L、緑 = H) */
  gpio_put_masked(PIN_BIT(BOOTCAMP_PIN_LED_RED) | PIN_BIT(BOOTCAMP_PIN_LED_GREEN), PIN_BIT(BOOTCAMP_PIN_LED_GREEN));
  for (;;) {
    printf("FAILED: %s status=%u (last_i2c_error=%d, i2c_error_count=%lu)\n", step, (unsigned)status,
           dev.platform.last_i2c_error, (unsigned long)dev.platform.i2c_error_count);
    sleep_ms(BOOTCAMP_FAIL_REPORT_INTERVAL_MS);
  }
}

/**
 * @brief 文字列をそのまま USB CDC に出す。
 *
 * stdio_put_string は、有効な stdio の出力先すべてに文字列を送る。第 4 引数 true で "\n" を "\r\n" に変換する
 * (USB の出力先は PICO_STDIO_USB_DEFAULT_CRLF = PICO_STDIO_DEFAULT_CRLF = 1 で変換が有効。SDK の stdio.c /
 * stdio.h / stdio_usb.h で確認)。printf を通さないので、長い文字列でも書式の処理をしない。
 * @param s NUL 終端の文字列
 */
static void put_text(const char *s) {
  stdio_put_string(s, -1, false, true);
}

/** @brief キー操作と表示の読み方を出す(各行 80 桁以内。depth_view_help_text)。カラー表示では画面を消してから出す。 */
static void print_help(void) {
  if (view.color) put_text(ANSI_RESET ANSI_CLEAR_SCREEN ANSI_HOME);
  put_text("\n");
  put_text(depth_view_help_text());
}

/**
 * @brief フレームのデータ準備を検出した時刻を記録し、直近 FPS_WINDOW 個の間隔からフレームレート × 10 を返す。
 *
 * 1 フレームごとの間隔から求めると、ポーリングの間隔(BOOTCAMP_POLL_INTERVAL_MS)ぶん値が揺れるので、
 * 複数フレームの合計時間で割る。記録が 2 個未満なら 0。
 * @param t_us 時刻 [µs]
 * @return フレームレート × 10
 */
static uint32_t record_frame_time(uint64_t t_us) {
  const uint32_t slots = FPS_WINDOW + 1u;
  frame_times[frame_times_next] = t_us;
  frame_times_next = (frame_times_next + 1u) % slots;
  if (frame_times_count < slots) frame_times_count++;
  /* 最も古い記録は、次に書く位置(満杯のとき)か先頭(満杯でないとき) */
  const uint64_t oldest = frame_times[frame_times_count == slots ? frame_times_next : 0u];
  return depth_view_fps_x10(frame_times_count - 1u, t_us - oldest);
}

/**
 * @brief USB から届いた 1 文字コマンドをすべて処理する(待たない)。
 *
 * getchar_timeout_us(0) は、SDK の stdio_get_until で各入力元を 1 回ずつ調べ、文字がなければ期限(呼び出した時刻)を
 * 過ぎているのですぐ PICO_ERROR_TIMEOUT を返す。USB の入力元(stdio_usb_in_chars)は、ターミナルが接続されていない
 * (DTR が立っていない)ときは何も読まずに PICO_ERROR_NO_DATA を返す(SDK の stdio.c / stdio_usb.c で確認)。
 * したがって USB 未接続でもこのループは止まらない。
 */
static void handle_keys(void) {
  int c;
  while ((c = getchar_timeout_us(0)) >= 0) {
    /* ヘルプの表示中に何か押されたら、表示を再開する(画面を消してから描く) */
    if (!time_reached(help_hold_until)) clear_before_draw = true;
    help_hold_until = get_absolute_time();
    switch (c) {
    case 'h':
    case 'H':
      view.flip_h = !view.flip_h;
      break;
    case 'v':
    case 'V':
      view.flip_v = !view.flip_v;
      break;
    case 'c':
    case 'C':
      view.color = !view.color;
      if (view.color) {
        clear_before_draw = true;
      } else {
        /* モノクロに切り替えたら色を戻して改行だけ出す(以後は ANSI エスケープを出さない) */
        put_text(ANSI_RESET "\n");
      }
      break;
    case '?':
      print_help();
      help_hold_until = make_timeout_time_ms(BOOTCAMP_HELP_HOLD_MS);
      clear_before_draw = true;
      break;
    default:
      break;
    }
  }
}

/**
 * @brief 1 フレームを表示する(距離画像とステータス DEPTH_VIEW_STATUS_LINES 行)。
 * @param frame_no フレーム番号(1 から)
 * @param fps_x10 フレームレート × 10
 * @param read_us vl53l8cx_get_ranging_data() の所要時間 [µs]
 * @param draw_us 前のフレームの描画(文字列の組み立てと USB への出力)の所要時間 [µs]
 */
static void draw_frame(uint32_t frame_no, uint32_t fps_x10, uint32_t read_us, uint32_t draw_us) {
  /* ULD の結果の配列をそのまま渡す(VL53L8CX_NB_TARGET_PER_ZONE = 1 なので添字 = ゾーン番号) */
  const depth_view_frame_t f = {BOOTCAMP_ZONE_SIDE, results.distance_mm, results.target_status, results.range_sigma_mm,
                                results.nb_target_detected};
  depth_view_status_t st = {
      .frame_no = frame_no,
      .warming_up = frame_no <= BOOTCAMP_WARMUP_FRAMES,
      .temp_c = results.silicon_temp_degc,
      .fps_x10 = fps_x10,
      .read_us = read_us,
      .draw_us = draw_us,
      .bytes_per_frame = dev.data_read_size,
      .ready_errors = ready_errors,
      .data_errors = data_errors,
      .zones = BOOTCAMP_RESOLUTION,
  };
  depth_view_stats(&f, view.sigma_max_mm, &st.stats);

  if (view.color && clear_before_draw) put_text(ANSI_CLEAR_SCREEN);
  clear_before_draw = false;
  (void)depth_view_render(frame_text, sizeof frame_text, &f, &view);
  put_text(frame_text);
  (void)depth_view_render_status(status_text, sizeof status_text, &st, &view);
  put_text(status_text);
  /* カラー表示では、画面の残り(エラー行やヘルプの残り)を消す */
  if (view.color) put_text(ANSI_CLEAR_BELOW);
}

int main(void) {
  leds_init();

  /* stdio_init_all は、CMake で有効にした stdio の出力先(このファームは USB CDC だけ)を初期化する */
  stdio_init_all();
  wait_usb_terminal();
  printf("\nxiao-vl53l8cx-bootcamp step 2 (ULD %s)\n", VL53L8CX_API_REVISION);

  i2c_bus_recover_result_t recover;
  const uint actual_hz = sensor_pins_init(&recover);
  printf("I2C bus recovery: %u clocks, STOP %s, SDA=%d SCL=%d\n", recover.clocks,
         recover.stop_sent ? "sent" : "not sent", (int)recover.sda_high, (int)recover.scl_high);
  printf("I2C1 %u Hz (requested %u Hz)\n", actual_hz, (unsigned)BOOTCAMP_I2C_BAUDRATE_HZ);

  dev.platform.address = VL53L8CX_DEFAULT_I2C_ADDRESS;
  dev.platform.i2c = i2c1;
  dev.platform.lpn_pin = BOOTCAMP_PIN_LPN;

  /* is_alive はデバイス ID(0xF0)とリビジョン ID(0x0C)を読んで確かめる。配線・アドレス・SPI/~I2C の
     設定の誤りはここで分かる */
  uint8_t alive = 0;
  uint8_t status = vl53l8cx_is_alive(&dev, &alive);
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_is_alive (I2C)", status);
  if (!alive) fail_forever("vl53l8cx_is_alive (unexpected device/revision id)", status);
  printf("sensor alive\n");

  /* init はセンサーへファームウェア(約 84 KB)を転送し、既定の設定を送る */
  const absolute_time_t init_start = get_absolute_time();
  status = vl53l8cx_init(&dev);
  const int64_t init_us = absolute_time_diff_us(init_start, get_absolute_time());
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_init", status);
  printf("init done in %lu ms\n", (unsigned long)(init_us / 1000));

  status = vl53l8cx_set_resolution(&dev, (uint8_t)BOOTCAMP_RESOLUTION);
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_set_resolution", status);
  /* 頻度は解像度に依存するので、解像度の後に設定する(ULD の vl53l8cx_set_ranging_frequency_hz のコメント) */
  status = vl53l8cx_set_ranging_frequency_hz(&dev, BOOTCAMP_RANGING_FREQ_HZ);
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_set_ranging_frequency_hz", status);
  status = vl53l8cx_start_ranging(&dev);
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_start_ranging", status);
  /* data_read_size は start_ranging が有効な出力から計算した、1 フレームで読むバイト数 */
  printf("ranging %ux%u @ %u Hz, %lu bytes per frame (press ? for help)\n", (unsigned)BOOTCAMP_ZONE_SIDE,
         (unsigned)BOOTCAMP_ZONE_SIDE, (unsigned)BOOTCAMP_RANGING_FREQ_HZ, (unsigned long)dev.data_read_size);

  led_set(BOOTCAMP_PIN_LED_GREEN, true);

  help_hold_until = get_absolute_time();
  uint32_t frame_no = 0;
  uint32_t draw_us = 0;
  for (;;) {
    handle_keys();

    uint8_t ready = 0;
    status = vl53l8cx_check_data_ready(&dev, &ready);
    if (status != VL53L8CX_STATUS_OK) {
      /* I2C の失敗か、センサーが返したエラー(GO2 のステータス)。表示して続ける(カラー表示では次の描画で消えるので、
         累計をステータス行にも出す) */
      ready_errors++;
      printf("check_data_ready error: status=%u (last_i2c_error=%d)\n", (unsigned)status, dev.platform.last_i2c_error);
      sleep_ms(100);
      continue;
    }
    if (!ready) {
      sleep_ms(BOOTCAMP_POLL_INTERVAL_MS);
      continue;
    }

    /* time_us_64 は起動からの時間 [µs](64 bit なので折り返しを考えなくてよい) */
    const uint64_t t_ready = time_us_64();
    status = vl53l8cx_get_ranging_data(&dev, &results);
    const uint32_t read_us = (uint32_t)(time_us_64() - t_ready);
    const uint32_t fps_x10 = record_frame_time(t_ready);
    frame_no++;
    if (status != VL53L8CX_STATUS_OK) {
      data_errors++;
      /* VL53L8CX_STATUS_CORRUPTED_FRAME(2)はヘッダとフッタの ID が食い違ったフレーム */
      printf("frame %lu: get_ranging_data error: status=%u\n", (unsigned long)frame_no, (unsigned)status);
      continue;
    }

    /* ヘルプの表示中は描画しない(フレームは読み続ける) */
    if (!time_reached(help_hold_until)) continue;

    const uint64_t t_draw = time_us_64();
    draw_frame(frame_no, fps_x10, read_us, draw_us);
    draw_us = (uint32_t)(time_us_64() - t_draw);
  }
}
