/* SPDX-License-Identifier: MIT */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "bootcamp_config.h"
#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "i2c_bus_recover.h"
#include "pico/stdio_usb.h"
#include "pico/stdlib.h"
#include "uld_util.h"
#include "vl53l8cx_api.h"

/** @brief GPIO 番号からピンマスク(その番号のビットだけ 1 の値)を作る。 */
#define PIN_BIT(pin) (1u << (pin))

/** @brief RGB LED の3色。アクティブ Low なので H が消灯。 */
#define LED_MASK (PIN_BIT(BOOTCAMP_PIN_LED_RED) | PIN_BIT(BOOTCAMP_PIN_LED_GREEN) | PIN_BIT(BOOTCAMP_PIN_LED_BLUE))

/** @brief 4x4 の 1 行のゾーン数。 */
#define ZONES_PER_ROW 4u

/** @brief 4x4 のゾーン数(VL53L8CX_RESOLUTION_4X4 = 16)。 */
#define ZONE_COUNT 16u

/**
 * @brief ULD のセンサー設定(約 2.3 KB。内部の一時バッファを含む)。スタックに置かないように静的領域に置く。
 *
 * platform メンバーは main() で埋める。それ以外は ULD が管理する。
 */
static VL53L8CX_Configuration dev;

/** @brief 1 フレームぶんの測距結果。dev と同じ理由で静的領域に置く。 */
static VL53L8CX_ResultsData results;

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

  /* INT は入力(Step 1 では読まない)。gpio_init は SIO の入力にする */
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
 * @brief 1 フレームの 4x4 の距離を格子状に表示する。
 *
 * 各ゾーンを「距離 [mm]/測距ステータス」で表示し、有効とみなさないステータス(5 / 9 以外)には '!' を付ける。
 * ゾーン番号 i を i / 4 行目・i % 4 列目に置く。センサーの向きと表示の上下左右の対応は未確認。
 * @param frame フレーム番号
 */
static void print_frame(uint32_t frame) {
  printf("frame %lu temp=%dC\n", (unsigned long)frame, (int)results.silicon_temp_degc);
  for (uint32_t row = 0; row < ZONE_COUNT / ZONES_PER_ROW; row++) {
    for (uint32_t col = 0; col < ZONES_PER_ROW; col++) {
      const uint32_t zone = row * ZONES_PER_ROW + col;
      /* VL53L8CX_NB_TARGET_PER_ZONE = 1 なので、ゾーン i の(唯一の)ターゲットは添字 i */
      const uint8_t status = results.target_status[zone];
      printf(" %5d/%3u%c", (int)results.distance_mm[zone], (unsigned)status,
             uld_target_status_is_valid(status) ? ' ' : '!');
    }
    printf("\n");
  }
}

int main(void) {
  leds_init();

  /* stdio_init_all は、CMake で有効にした stdio の出力先(このファームは USB CDC だけ)を初期化する */
  stdio_init_all();
  wait_usb_terminal();
  printf("\nxiao-vl53l8cx-bootcamp step 1 (ULD %s)\n", VL53L8CX_API_REVISION);

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

  status = vl53l8cx_set_resolution(&dev, VL53L8CX_RESOLUTION_4X4);
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_set_resolution", status);
  /* 頻度は解像度に依存するので、解像度の後に設定する(ULD の vl53l8cx_set_ranging_frequency_hz のコメント) */
  status = vl53l8cx_set_ranging_frequency_hz(&dev, BOOTCAMP_RANGING_FREQ_HZ);
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_set_ranging_frequency_hz", status);
  status = vl53l8cx_start_ranging(&dev);
  if (status != VL53L8CX_STATUS_OK) fail_forever("vl53l8cx_start_ranging", status);
  printf("ranging 4x4 @ %u Hz ('!' = target_status other than 5/9)\n", (unsigned)BOOTCAMP_RANGING_FREQ_HZ);

  led_set(BOOTCAMP_PIN_LED_GREEN, true);

  uint32_t frame = 0;
  for (;;) {
    uint8_t ready = 0;
    status = vl53l8cx_check_data_ready(&dev, &ready);
    if (status != VL53L8CX_STATUS_OK) {
      /* I2C の失敗か、センサーが返したエラー(GO2 のステータス)。表示して続ける */
      printf("check_data_ready error: status=%u (last_i2c_error=%d)\n", (unsigned)status, dev.platform.last_i2c_error);
      sleep_ms(100);
      continue;
    }
    if (!ready) {
      sleep_ms(BOOTCAMP_POLL_INTERVAL_MS);
      continue;
    }

    status = vl53l8cx_get_ranging_data(&dev, &results);
    frame++;
    if (status != VL53L8CX_STATUS_OK) {
      /* VL53L8CX_STATUS_CORRUPTED_FRAME(2)はヘッダとフッタの ID が食い違ったフレーム */
      printf("frame %lu: get_ranging_data error: status=%u\n", (unsigned long)frame, (unsigned)status);
      continue;
    }
    print_frame(frame);
  }
}
