/* SPDX-License-Identifier: MIT */
/**
 * @file bootcamp_config.h
 * @brief ピン番号・I2C の設定・測距の設定をまとめた設定ヘッダ。
 *
 * 配線は README の「配線」の表が正。値は RP2040 の GPIO 番号。このヘッダは Pico SDK に依存しない。
 */
#ifndef BOOTCAMP_CONFIG_H
#define BOOTCAMP_CONFIG_H

/** @brief センサーの SDA(XIAO ピン D4)。I2C1。 */
#define BOOTCAMP_PIN_SDA 6u
/** @brief センサーの SCL(XIAO ピン D5)。I2C1。 */
#define BOOTCAMP_PIN_SCL 7u
/** @brief センサーの INT(XIAO ピン D0)。Step 1 では使わない(データの準備はポーリングで確認する)。 */
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

/** @brief 測距の頻度 [Hz]。4x4 では 1〜60 を指定できる(ULD の vl53l8cx_set_ranging_frequency_hz のコメント)。 */
#define BOOTCAMP_RANGING_FREQ_HZ 10u

/** @brief vl53l8cx_check_data_ready() でデータの準備を確認する間隔 [ms]。 */
#define BOOTCAMP_POLL_INTERVAL_MS 5u

/** @brief 初期化に失敗して止まっているとき、失敗内容を表示し直す間隔 [ms]。 */
#define BOOTCAMP_FAIL_REPORT_INTERVAL_MS 2000u

#endif // BOOTCAMP_CONFIG_H
