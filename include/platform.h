/* SPDX-License-Identifier: MIT */
/**
 * @file platform.h
 * @brief VL53L8CX ULD のプラットフォーム層(RP2040 / Pico SDK の I2C で実装)。
 *
 * ULD(third_party/vl53l8cx_uld)の vl53l8cx_api.h が `#include "platform.h"` と固定の名前で読むので、
 * このファイル名にしている。ULD はここから次のものを受け取る:
 * - VL53L8CX_Platform 型(VL53L8CX_Configuration の platform メンバー)
 * - VL53L8CX_NB_TARGET_PER_ZONE と、測距結果のうち使わない出力を外す VL53L8CX_DISABLE_* マクロ
 * - I2C の読み書き・待ち・バイト順入れ替えの関数(VL53L8CX_RdByte など)
 *
 * 関数の戻り値は ULD の流儀に合わせ、成功で 0、失敗で 0 以外(VL53L8CX_PLATFORM_ERROR)を返す。
 * ULD は各呼び出しの戻り値を status に OR で積み上げるので、失敗したことだけが呼び出し元に伝わる。
 * 失敗の詳細(Pico SDK の戻り値)は VL53L8CX_Platform の last_i2c_error に残す。
 */
#ifndef VL53L8CX_PLATFORM_H
#define VL53L8CX_PLATFORM_H

#include <stdint.h>
/* ULD のプラグイン(vl53l8cx_plugin_motion_indicator.c、vl53l8cx_plugin_xtalk.c)は memset / memcpy を使うが
   string.h を自分では include せず、platform.h 経由で読まれる前提になっている。ULD は改変しないのでここで読む */
#include <string.h>

#include "hardware/i2c.h"

/**
 * @brief 1 ゾーンあたりに報告するターゲット数(1〜4)。
 *
 * ULD はこの値で測距結果の配列の大きさと、センサーに設定する出力の形式を決める。既定は 2(手前の対象と奥の壁を同じ
 * ゾーンで捉えるため)。CMake のキャッシュ変数 BOOTCAMP_TARGETS_PER_ZONE で変えられる(CMake が compile definition で
 * ULD のソースにも同じ値を渡す。ここの既定値は CMake を通さない場合のためのもので、CMake の既定と揃えている)。
 */
#ifndef VL53L8CX_NB_TARGET_PER_ZONE
#define VL53L8CX_NB_TARGET_PER_ZONE 2U
#endif

/*
 * 測距結果のうち使わない出力を無効にする。定義した項目は VL53L8CX_ResultsData から消え、I2C で読むデータも減る。
 * 残すもの: 距離(distance_mm)、測距ステータス(target_status)、sigma(range_sigma_mm)、ターゲット数(nb_target_detected)、
 * 信号強度(signal_per_spad。Step 3 でブラウザの「IR 画像」に使う)、有効 SPAD 数(nb_spads_enabled。Step 3 で
 * signal_per_spad と並べて見せる)。
 * ターゲット数を残すのは、ULD がターゲットのないゾーンの target_status を 255 にする処理がこの出力を使うため
 * (vl53l8cx_get_ranging_data の VL53L8CX_DISABLE_NB_TARGET_DETECTED で囲まれた部分)。
 */
/** @brief 周囲光(ambient_per_spad)を出力しない。 */
#define VL53L8CX_DISABLE_AMBIENT_PER_SPAD
/** @brief 反射率の推定値(reflectance)を出力しない。 */
#define VL53L8CX_DISABLE_REFLECTANCE_PERCENT
/** @brief 動き検出(motion_indicator)を出力しない。 */
#define VL53L8CX_DISABLE_MOTION_INDICATOR

/** @brief プラットフォーム関数が失敗したときの戻り値。ULD の VL53L8CX_STATUS_ERROR と同じ値。 */
#define VL53L8CX_PLATFORM_ERROR ((uint8_t)255U)

/** @brief センサー 1 台ぶんの接続情報。VL53L8CX_Configuration の platform メンバーとして ULD が持ち回る。 */
typedef struct {
  /**
   * @brief I2C アドレス(8 bit 表記。既定は VL53L8CX_DEFAULT_I2C_ADDRESS = 0x52)。
   *
   * ULD はこの表記で扱い、vl53l8cx_set_i2c_address() もこのメンバーを書き換える。Pico SDK には 1 bit 右シフトした
   * 7 bit のアドレス(0x29)を渡す。
   */
  uint16_t address;
  /** @brief 使う I2C インスタンス(XIAO RP2040 の D4 / D5 は i2c1)。 */
  i2c_inst_t *i2c;
  /** @brief LPn(Low で I2C 通信を止める)につないだ GPIO 番号。VL53L8CX_Reset_Sensor() で使う。 */
  uint lpn_pin;
  /**
   * @brief 最後に失敗した I2C 転送の Pico SDK の戻り値(PICO_ERROR_GENERIC / PICO_ERROR_TIMEOUT)。
   *
   * 途中で一部のバイトだけ送れた場合は PICO_ERROR_GENERIC にする。失敗がなければ 0 のまま。
   */
  int last_i2c_error;
  /** @brief I2C 転送が失敗した回数。 */
  uint32_t i2c_error_count;
} VL53L8CX_Platform;

/**
 * @brief レジスタから 1 バイト読む。
 * @param p_platform 接続情報
 * @param RegisterAdress レジスタアドレス
 * @param p_value 読んだ値の格納先
 * @return 成功で 0、失敗で VL53L8CX_PLATFORM_ERROR
 */
uint8_t VL53L8CX_RdByte(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_value);

/**
 * @brief レジスタに 1 バイト書く。
 * @param p_platform 接続情報
 * @param RegisterAdress レジスタアドレス
 * @param value 書く値
 * @return 成功で 0、失敗で VL53L8CX_PLATFORM_ERROR
 */
uint8_t VL53L8CX_WrByte(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t value);

/**
 * @brief RegisterAdress から連続して size バイト読む(1 回の I2C 転送)。
 * @param p_platform 接続情報
 * @param RegisterAdress 先頭のレジスタアドレス
 * @param p_values 読んだ値の格納先(size バイト)
 * @param size 読むバイト数。0 なら何もせず成功を返す
 * @return 成功で 0、失敗で VL53L8CX_PLATFORM_ERROR
 */
uint8_t VL53L8CX_RdMulti(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size);

/**
 * @brief RegisterAdress から連続して size バイト書く。
 *
 * ULD_WRITE_CHUNK_BYTES バイトずつの I2C 転送に分け、各転送の先頭にレジスタアドレスを付け直して送る
 * (理由は src/platform.c)。途中の転送が失敗したら、残りは送らずに失敗を返す。
 * @param p_platform 接続情報
 * @param RegisterAdress 先頭のレジスタアドレス
 * @param p_values 書くデータ(size バイト)
 * @param size 書くバイト数。0 なら何もせず成功を返す
 * @return 成功で 0、失敗で VL53L8CX_PLATFORM_ERROR
 */
uint8_t VL53L8CX_WrMulti(VL53L8CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size);

/**
 * @brief LPn を Low → High にして、センサーの I2C 通信をいったん止めてから戻す。
 *
 * ULD からは呼ばれない任意の関数。LPn はセンサーの電源を切らないので、センサーの内部状態(ロード済みのファームウェアや
 * 設定)が消えるかどうかは、この関数では保証しない(未確認)。
 * @param p_platform 接続情報(lpn_pin を使う)
 * @return 常に 0
 */
uint8_t VL53L8CX_Reset_Sensor(VL53L8CX_Platform *p_platform);

/**
 * @brief 4 バイトごとにバイト順を反転する(センサーの 32 bit ビッグエンディアンのデータをホストの順にする)。
 *
 * 本体は uld_swap_buffer()。size が 4 の倍数でない場合、末尾の余りは変更しない。
 * @param buffer 対象のバッファ
 * @param size 対象のバイト数
 */
void VL53L8CX_SwapBuffer(uint8_t *buffer, uint16_t size);

/**
 * @brief 指定したミリ秒だけ待つ。
 * @param p_platform 接続情報(使わない)
 * @param TimeMs 待つ時間 [ms]
 * @return 常に 0
 */
uint8_t VL53L8CX_WaitMs(VL53L8CX_Platform *p_platform, uint32_t TimeMs);

#endif // VL53L8CX_PLATFORM_H
