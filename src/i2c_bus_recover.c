/* SPDX-License-Identifier: MIT */
#include "i2c_bus_recover.h"

#include "hardware/gpio.h"
#include "hardware/timer.h"

/** @brief 手動クロックの半周期 [µs]。5 µs で約 100 kHz(Standard-mode)。通常の 400 kHz より遅くして余裕を持たせる。 */
#define HALF_PERIOD_US 5u

/** @brief SCL を解放した後、スレーブのクロックストレッチが終わって High になるのを待つ最大時間 [µs]。 */
#define SCL_RELEASE_TIMEOUT_US 1000u

/**
 * @brief ピンを Low に引く(オープンドレインの Low)。
 *
 * 出力値は i2c_bus_recover() の最初に L にしてあるので、方向を出力にするだけで L が出る。
 * @param pin GPIO 番号
 */
static void pull_low(uint pin) {
  gpio_set_dir(pin, GPIO_OUT);
}

/**
 * @brief ピンを解放する(入力にしてプルアップで High に戻す)。
 * @param pin GPIO 番号
 */
static void release(uint pin) {
  gpio_set_dir(pin, GPIO_IN);
}

/** @brief 半周期だけ待つ。busy_wait_us_32 はタイマーを読みながら空ループで待つ(割り込みを使わない)。 */
static void half_period(void) {
  busy_wait_us_32(HALF_PERIOD_US);
}

/**
 * @brief SCL を解放し、High になるまで(最大 SCL_RELEASE_TIMEOUT_US)待つ。スレーブのクロックストレッチに対応する。
 * @param scl_pin SCL の GPIO 番号
 * @return SCL が High になれば true
 */
static bool release_scl(uint scl_pin) {
  release(scl_pin);
  for (uint32_t waited = 0; !gpio_get(scl_pin); waited++) {
    if (waited >= SCL_RELEASE_TIMEOUT_US) return false;
    busy_wait_us_32(1);
  }
  return true;
}

i2c_bus_recover_result_t i2c_bus_recover(uint sda_pin, uint scl_pin) {
  i2c_bus_recover_result_t result = {0, false, false, false};

  /* gpio_init は SIO の入力・出力値 L にする。内蔵プルダウン(リセット既定で有効)は外し、キャリアのプルアップに任せる */
  gpio_init(sda_pin);
  gpio_init(scl_pin);
  gpio_disable_pulls(sda_pin);
  gpio_disable_pulls(scl_pin);
  half_period();

  bool scl_ok = gpio_get(scl_pin);

  /* SDA が Low の間、クロックを 1 つずつ出す。スレーブは SCL の立ち下がりで次のビットを出すので、読み出し途中の
     データの残りを出し切ると、ACK の位置でマスターが ACK を返さない(SDA は High のまま)ことで SDA を解放する */
  while (scl_ok && !gpio_get(sda_pin) && result.clocks < I2C_BUS_RECOVER_MAX_CLOCKS) {
    pull_low(scl_pin);
    half_period();
    scl_ok = release_scl(scl_pin);
    half_period();
    result.clocks++;
  }

  /* STOP 条件: SCL が High の間に SDA を Low → High にする。そのために SCL を Low にしてから SDA を Low にし、
     SCL を High に戻してから SDA を解放する */
  if (scl_ok && gpio_get(sda_pin)) {
    pull_low(scl_pin);
    half_period();
    pull_low(sda_pin);
    half_period();
    scl_ok = release_scl(scl_pin);
    half_period();
    release(sda_pin);
    half_period();
    result.stop_sent = scl_ok;
  }

  release(sda_pin);
  release(scl_pin);
  result.sda_high = gpio_get(sda_pin);
  result.scl_high = gpio_get(scl_pin);
  return result;
}
