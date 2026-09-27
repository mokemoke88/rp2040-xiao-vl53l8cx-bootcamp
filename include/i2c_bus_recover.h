/* SPDX-License-Identifier: MIT */
/**
 * @file i2c_bus_recover.h
 * @brief I2C バスの復旧(スレーブが SDA を Low に保持したままのバスを、SCL を手動でクロックして解放させる)。
 *
 * 転送の途中で MCU だけがリセットされると、スレーブ(センサー)は読み出しの途中のまま SDA を Low に保持していることが
 * ある。この状態では MCU の I2C ブロックは START を出せない。I2C の仕様(UM10204 の Bus clear)にある方法で、
 * SCL を最大 9 回クロックしてスレーブに残りのビットを出し切らせ、SDA が High に戻ったら STOP を出してバスを空きにする。
 * i2c_init / gpio_set_function(GPIO_FUNC_I2C) より前に呼ぶ。
 */
#ifndef I2C_BUS_RECOVER_H
#define I2C_BUS_RECOVER_H

#include <stdbool.h>

#include "pico/types.h"

/** @brief SCL を手動でクロックする最大回数(1 バイト + ACK の 9 ビット)。 */
#define I2C_BUS_RECOVER_MAX_CLOCKS 9u

/** @brief i2c_bus_recover() の結果。 */
typedef struct {
  /** @brief SDA を解放させるために出したクロックの数(0〜I2C_BUS_RECOVER_MAX_CLOCKS)。 */
  uint clocks;
  /** @brief STOP を出したか(SDA が High に戻った場合だけ出す)。 */
  bool stop_sent;
  /** @brief 終了時の SDA が High か。 */
  bool sda_high;
  /** @brief 終了時の SCL が High か。false ならスレーブが SCL を Low に保持している(クロックストレッチが終わらない)。 */
  bool scl_high;
} i2c_bus_recover_result_t;

/**
 * @brief I2C バスを復旧する。
 *
 * SDA / SCL を SIO の入力(内蔵プルアップ・プルダウンなし)にし、オープンドレインを模して操作する(Low は出力 L、
 * High は入力にしてプルアップに任せる)。SDA が Low の間、SCL を最大 I2C_BUS_RECOVER_MAX_CLOCKS 回クロックする。
 * SDA が High なら(はじめから High だった場合も)STOP を出す。終了時は両ピンとも SIO の入力のまま。
 * @param sda_pin SDA の GPIO 番号
 * @param scl_pin SCL の GPIO 番号
 * @return 復旧の結果
 */
i2c_bus_recover_result_t i2c_bus_recover(uint sda_pin, uint scl_pin);

#endif // I2C_BUS_RECOVER_H
