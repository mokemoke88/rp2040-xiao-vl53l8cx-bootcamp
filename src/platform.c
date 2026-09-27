/* SPDX-License-Identifier: MIT */
#include "platform.h"

#include <stdbool.h>
#include <stddef.h>

#include "hardware/gpio.h"
#include "pico/error.h"
#include "pico/time.h"
#include "uld_util.h"

/** @brief VL53L8CX_Reset_Sensor() で LPn を Low にしておく時間と、High に戻した後に待つ時間 [ms]。 */
#define RESET_LPN_WAIT_MS 10u

/**
 * @brief VL53L8CX_WrMulti() の送信用バッファ(レジスタアドレス + 1 塊ぶんのデータ)。
 *
 * スタックに置かずに静的領域に置く(258 バイト)。センサーは 1 台で、ULD の呼び出しは main() からの一本道なので
 * 同時に使われることはない。
 */
static uint8_t write_buf[ULD_REG_ADDR_BYTES + ULD_WRITE_CHUNK_BYTES];

/**
 * @brief ULD の 8 bit 表記の I2C アドレスを、Pico SDK が受け取る 7 bit のアドレスに直す。
 * @param p_platform 接続情報
 * @return 7 bit のアドレス(0x52 なら 0x29)
 */
static uint8_t addr7(const VL53L8CX_Platform *p_platform) {
  return (uint8_t)(p_platform->address >> 1);
}

/**
 * @brief Pico SDK の I2C 関数の戻り値が「全バイト転送できた」かを判定し、失敗なら記録する。
 *
 * i2c_write_timeout_us / i2c_read_timeout_us は、成功すると転送したバイト数を返す。アドレスに ACK がない・
 * タイムアウトなどでは負の値(PICO_ERROR_GENERIC / PICO_ERROR_TIMEOUT)を返す。書き込みでデータに ACK が
 * 返らなかった場合は、それまでに送れたバイト数(len より小さい正の値)を返す(SDK の i2c.c で確認)。
 * @param p_platform 接続情報(失敗の記録先)
 * @param rc SDK の関数の戻り値
 * @param len 転送しようとしたバイト数
 * @return 全バイト転送できたら true
 */
static bool transfer_ok(VL53L8CX_Platform *p_platform, int rc, size_t len) {
  if (rc == (int)len) return true;
  p_platform->last_i2c_error = rc < 0 ? rc : PICO_ERROR_GENERIC;
  p_platform->i2c_error_count++;
  return false;
}

uint8_t VL53L8CX_RdByte(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_value) {
  return VL53L8CX_RdMulti(p_platform, RegisterAdress, p_value, 1u);
}

uint8_t VL53L8CX_WrByte(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t value) {
  return VL53L8CX_WrMulti(p_platform, RegisterAdress, &value, 1u);
}

uint8_t VL53L8CX_RdMulti(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size) {
  if (size == 0u) return 0;

  uint8_t reg[ULD_REG_ADDR_BYTES];
  (void)uld_pack_write(reg, RegisterAdress, NULL, 0u);

  /* 読み出しは「レジスタアドレスを書く → RESTART → 読む」の 1 トランザクションにする。
     i2c_write_timeout_us の nostop = true は、最後のバイトに STOP を付けずにバスを保持したまま戻る。
     SDK はこのとき次の転送の最初のバイトに RESTART を付ける印(i2c_inst の restart_on_next)を立てるので、
     続く i2c_read_timeout_us は最初のバイトの命令に RESTART ビット、最後のバイトの命令に STOP ビットを立てる
     (SDK の i2c.c で確認。バス上の波形は未確認)。
     タイムアウトは転送全体に対する 1 つの期限として扱われる(i2c_write_blocking_until → init_single_timeout_until)。
     アドレスの書き込みが失敗した場合、SDK の restart_on_next は立ったまま残り、次の転送が RESTART 付きで始まる。
     その場合のハードウェアの挙動は未確認 */
  int rc =
      i2c_write_timeout_us(p_platform->i2c, addr7(p_platform), reg, sizeof reg, true, uld_i2c_timeout_us(sizeof reg));
  if (!transfer_ok(p_platform, rc, sizeof reg)) return VL53L8CX_PLATFORM_ERROR;

  rc = i2c_read_timeout_us(p_platform->i2c, addr7(p_platform), p_values, size, false, uld_i2c_timeout_us(size));
  if (!transfer_ok(p_platform, rc, size)) return VL53L8CX_PLATFORM_ERROR;
  return 0;
}

/**
 * @brief uld_write_chunked() から呼ばれ、組み立て済みの 1 塊を 1 回の I2C 書き込み(最後に STOP)で送る。
 * @param ctx 接続情報(VL53L8CX_Platform *)
 * @param packet レジスタアドレス + データ
 * @param len packet のバイト数
 * @return 全バイト送れたら true
 */
static bool send_chunk(void *ctx, const uint8_t *packet, uint32_t len) {
  VL53L8CX_Platform *p_platform = ctx;
  const int rc = i2c_write_timeout_us(p_platform->i2c, addr7(p_platform), packet, len, false, uld_i2c_timeout_us(len));
  return transfer_ok(p_platform, rc, len);
}

uint8_t VL53L8CX_WrMulti(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size) {
  /* レジスタアドレスとデータは、1 回の i2c_write_timeout_us にまとめて送る。
     SDK の書き込み関数は、前の転送が nostop = true だと最初のバイトの命令に RESTART ビットを立てる(SDK の i2c.c の
     i2c_write_blocking_internal で確認)。I2C では RESTART の後にスレーブアドレスが送られるので、「アドレスを nostop で
     書く → データを書く」と 2 回に分けると、センサーからは新しい書き込みが始まったように見え、データの先頭 2 バイトが
     レジスタアドレスとして解釈されるはず(バス上の波形は未確認)。
     SDK には RESTART を付けずに続けて書く i2c_write_burst_blocking もあるが、タイムアウト付きの版がないので使わない。

     ファームウェア転送は 1 回の呼び出しで 0x8000 バイトあり、まとめて送るには同じ大きさのバッファが要る。
     そこで ULD_WRITE_CHUNK_BYTES バイトずつに分け、塊ごとに先頭のレジスタアドレスを付け直して、STOP で区切った
     別々の書き込みとして送る(uld_write_chunked)。センサーが「書き込みごとにレジスタアドレスを 1 ずつ進める」ことが
     前提で、崩れていればファームウェア転送後のチェックサム確認(vl53l8cx_init の VL53L8CX_STATUS_FW_CHECKSUM_FAIL)で
     分かる。途中の塊が失敗したら、残りは送らない */
  if (!uld_write_chunked(RegisterAdress, p_values, size, write_buf, ULD_WRITE_CHUNK_BYTES, send_chunk, p_platform)) {
    return VL53L8CX_PLATFORM_ERROR;
  }
  return 0;
}

uint8_t VL53L8CX_Reset_Sensor(VL53L8CX_Platform *p_platform) {
  /* gpio_put は出力値を変えるだけで、方向は変えない。LPn のピンは呼び出し元で出力に設定しておく */
  gpio_put(p_platform->lpn_pin, false);
  sleep_ms(RESET_LPN_WAIT_MS);
  gpio_put(p_platform->lpn_pin, true);
  sleep_ms(RESET_LPN_WAIT_MS);
  return 0;
}

void VL53L8CX_SwapBuffer(uint8_t *buffer, uint16_t size) {
  uld_swap_buffer(buffer, size);
}

uint8_t VL53L8CX_WaitMs(VL53L8CX_Platform *p_platform, uint32_t TimeMs) {
  (void)p_platform;
  /* sleep_ms は、指定時間が過ぎるまで戻らない。ULD はセンサーの応答待ちのポーリング間隔などに使う */
  sleep_ms(TimeMs);
  return 0;
}
