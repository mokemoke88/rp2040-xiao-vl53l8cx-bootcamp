/* SPDX-License-Identifier: MIT */
/**
 * @file bootcamp_config.h
 * @brief ピン番号・I2C の設定・測距の設定をまとめた設定ヘッダ。
 *
 * 配線は README の「配線」の表が正。値は RP2040 の GPIO 番号。このヘッダは Pico SDK に依存しない。
 */
#ifndef BOOTCAMP_CONFIG_H
#define BOOTCAMP_CONFIG_H

#include <stdbool.h>

/** @brief センサーの SDA(XIAO ピン D4)。I2C1。 */
#define BOOTCAMP_PIN_SDA 6u
/** @brief センサーの SCL(XIAO ピン D5)。I2C1。 */
#define BOOTCAMP_PIN_SCL 7u
/** @brief センサーの INT(XIAO ピン D0)。Step 2 まででは使わない(データの準備はポーリングで確認する)。 */
#define BOOTCAMP_PIN_INT 26u
/** @brief センサーの ~LP(XIAO ピン D1)。Low で I2C 通信を止める。 */
#define BOOTCAMP_PIN_LPN 27u

/** @brief オンボード RGB LED の赤。アクティブ Low(L で点灯)。センサーの初期化・測距の失敗表示に使う。 */
#define BOOTCAMP_PIN_LED_RED 17u
/** @brief オンボード RGB LED の緑。アクティブ Low。測距を始めたら点灯する。 */
#define BOOTCAMP_PIN_LED_GREEN 16u
/** @brief オンボード RGB LED の青。アクティブ Low。使わないので消灯(H)に固定する。 */
#define BOOTCAMP_PIN_LED_BLUE 25u

/** @brief I2C のクロック [Hz]。ブレッドボードで組むので 400 kHz(Fast-mode)にする(README の決定事項)。 */
#define BOOTCAMP_I2C_BAUDRATE_HZ 400000u

/** @brief 起動時に USB CDC の接続(ターミナルが開かれること)を待つ最大時間 [ms]。初期化のログを見られるようにする。 */
#define BOOTCAMP_USB_WAIT_MS 3000u

/** @brief 一辺のゾーン数(4 または 8)。 */
#define BOOTCAMP_ZONE_SIDE 8u

/**
 * @brief 解像度(ゾーン数)。ULD の VL53L8CX_RESOLUTION_4X4 = 16 / VL53L8CX_RESOLUTION_8X8 = 64 に対応する値で、
 *        vl53l8cx_set_resolution() にそのまま渡す。
 */
#define BOOTCAMP_RESOLUTION (BOOTCAMP_ZONE_SIDE * BOOTCAMP_ZONE_SIDE)

/**
 * @brief 測距の頻度 [Hz]。4x4 では 1〜60、8x8 では 1〜15 を指定できる(ULD の vl53l8cx_set_ranging_frequency_hz の
 *        コメント)。解像度を設定した後に設定する。
 */
#define BOOTCAMP_RANGING_FREQ_HZ 15u

/**
 * @brief 有効とみなす sigma の上限 [mm](この値以下を有効にする)。暫定値。実機での分布(ステータス行の sigma の
 *        中央値・最大)を見て調整する。
 */
#define BOOTCAMP_SIGMA_MAX_MM 50u

/** @brief 距離の色・濃淡を割り当てる上限 [mm]。これを超える距離は範囲外(カラーは暗い紫、モノクロは '.')で表示する。 */
#define BOOTCAMP_RANGE_MAX_MM 2000u

/**
 * @brief 起動時の左右反転。確定値(2026-09-27、ユーザー報告)。
 *
 * センサーを自分に向け、キャリアの 9 ピン列を左にして持ったとき、左右反転あり・上下反転なしで表示と見た目が一致した。
 * このときゾーン 0 は表示の右上で、物理的にも「センサーを正面から見て、9 ピン列を左にしたときの右上」にある。
 */
#define BOOTCAMP_FLIP_H_DEFAULT true

/** @brief 起動時の上下反転。確定値(BOOTCAMP_FLIP_H_DEFAULT を参照)。 */
#define BOOTCAMP_FLIP_V_DEFAULT false

/** @brief 起動時にカラー表示(ANSI 256 色)にするか。false ならモノクロ(ANSI エスケープなし)。 */
#define BOOTCAMP_COLOR_DEFAULT true

/** @brief 起動直後に無効として注記するフレーム数。1 フレーム目はステータスが 6 / 13 になる(Step 1 の実機で確認)。 */
#define BOOTCAMP_WARMUP_FRAMES 1u

/** @brief '?' でヘルプを出したとき、距離画像の表示を止めておく時間 [ms](何かキーを押せばすぐ戻る)。 */
#define BOOTCAMP_HELP_HOLD_MS 5000u

/** @brief vl53l8cx_check_data_ready() でデータの準備を確認する間隔 [ms]。 */
#define BOOTCAMP_POLL_INTERVAL_MS 5u

/** @brief 初期化に失敗して止まっているとき、失敗内容を表示し直す間隔 [ms]。 */
#define BOOTCAMP_FAIL_REPORT_INTERVAL_MS 2000u

#endif // BOOTCAMP_CONFIG_H
