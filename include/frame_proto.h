/* SPDX-License-Identifier: MIT */
/**
 * @file frame_proto.h
 * @brief PC へ送るバイナリメッセージ(測距フレーム・ログ・状態)の組み立て、CRC-32、COBS。
 *
 * 形式の定義は docs/frame-format.md が正。このヘッダはその実装で、stdint.h / stdbool.h / stddef.h だけに依存し、
 * Pico SDK にも ULD の型にも依存しない。ホストの gcc で単体テストする(tests/test_frame_proto.c。
 * docs/frame-vectors.json のテストベクタと一致することも検査する)。
 *
 * 層の分け方:
 * - ペイロード(経路に依存しない): fp_build_frame() / fp_build_log() / fp_build_status()
 * - CRC-32: fp_append_crc32() でペイロードの後ろにリトルエンディアンで付ける
 * - USB シリアルのリンク層: fp_cobs_frame() で「ペイロード + CRC」を COBS にし、区切りの 0x00 を付ける
 *
 * 組み立て関数は、出力先の容量が足りない・入力が形式の範囲外のときは何も書かずに 0 を返す。
 */
#ifndef FRAME_PROTO_H
#define FRAME_PROTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** @brief ペイロードの先頭のマジック 1 バイト目('V')。 */
#define FP_MAGIC0 0x56u
/** @brief ペイロードの先頭のマジック 2 バイト目('8')。 */
#define FP_MAGIC1 0x38u
/** @brief 形式の版。 */
#define FP_VERSION 1u

/** @brief メッセージ種別: 測距フレーム。 */
#define FP_TYPE_FRAME 1u
/** @brief メッセージ種別: ログ文字列。 */
#define FP_TYPE_LOG 2u
/** @brief メッセージ種別: 状態。 */
#define FP_TYPE_STATUS 3u

/** @brief 全種別に共通のヘッダのバイト数(マジック 2、版 1、種別 1、シーケンス番号 4、タイムスタンプ 4)。 */
#define FP_COMMON_HEADER_BYTES 12u
/** @brief 測距フレームのヘッダのバイト数(共通ヘッダ + 辺 1、ターゲット数 1、フィールドマスク 2、温度 1、予約 1)。 */
#define FP_FRAME_HEADER_BYTES 18u
/** @brief ログのヘッダのバイト数(共通ヘッダ + レベル 1、予約 1、文字列の長さ 2)。 */
#define FP_LOG_HEADER_BYTES 16u
/** @brief 状態のヘッダのバイト数(共通ヘッダ + 辺 1、ターゲット数 1、マスク 2、頻度 1、フラグ 1、I2C 4、読み出し 4、
 *         版の文字列の長さ 1)。 */
#define FP_STATUS_HEADER_BYTES 27u

/** @brief フィールド: 距離 [mm](int16、ターゲットごと)。 */
#define FP_FIELD_DISTANCE (1u << 0)
/** @brief フィールド: 測距ステータス(uint8、ターゲットごと)。 */
#define FP_FIELD_TARGET_STATUS (1u << 1)
/** @brief フィールド: 距離の sigma [mm](uint16、ターゲットごと)。 */
#define FP_FIELD_RANGE_SIGMA (1u << 2)
/** @brief フィールド: ターゲット数(uint8、ゾーンごと)。 */
#define FP_FIELD_NB_TARGET (1u << 3)
/** @brief フィールド: 信号強度 [kcps/SPAD](uint32、ターゲットごと)。 */
#define FP_FIELD_SIGNAL (1u << 4)
/** @brief フィールド: 有効 SPAD 数(uint32、ゾーンごと)。 */
#define FP_FIELD_NB_SPADS (1u << 5)
/** @brief 版 1 で定義しているフィールドのビットすべて。ほかのビット(6〜15)は予約で、立っていたら不正。 */
#define FP_FIELDS_KNOWN 0x003Fu

/** @brief 一辺のゾーン数の最大。 */
#define FP_MAX_SIDE 8u
/** @brief ゾーンあたりターゲット数の最大(ULD の VL53L8CX_NB_TARGET_PER_ZONE の範囲 1〜4)。 */
#define FP_MAX_TARGETS 4u

/** @brief 全フィールドを含む測距フレームのペイロードの最大(8x8、4 ターゲット。ゾーンごとのフィールドはターゲット数によらない)。 */
#define FP_FRAME_PAYLOAD_MAX                                                                                           \
  (FP_FRAME_HEADER_BYTES + FP_MAX_SIDE * FP_MAX_SIDE * FP_MAX_TARGETS * (2u + 1u + 2u + 4u) +                          \
   FP_MAX_SIDE * FP_MAX_SIDE * (1u + 4u))

/** @brief ログの文字列の最大バイト数。長い文字列は切り詰める。 */
#define FP_LOG_TEXT_MAX 200u
/** @brief 状態のファームウェアの版の文字列の最大バイト数。長い文字列は切り詰める。 */
#define FP_VERSION_TEXT_MAX 64u

/** @brief どの種別のペイロードも収まる大きさ(測距フレームが最大)。 */
#define FP_PAYLOAD_MAX FP_FRAME_PAYLOAD_MAX
/** @brief CRC-32 のバイト数。 */
#define FP_CRC_BYTES 4u

/**
 * @brief n バイトを COBS にしたときの長さの上限(区切りの 0x00 を含まない)。
 *
 * 正確な最大は n ≥ 1 で n + ⌈n / 254⌉、n = 0 で 1。この式 n + n / 254 + 1 はどちらも上から押さえる。
 */
#define FP_COBS_MAX(n) ((n) + (n) / 254u + 1u)

/** @brief USB シリアルで 1 メッセージが占める最大バイト数(ペイロード + CRC を COBS にし、区切りの 0x00 を足す)。 */
#define FP_SERIAL_MAX (FP_COBS_MAX(FP_PAYLOAD_MAX + FP_CRC_BYTES) + 1u)

/** @brief 状態メッセージのフラグ: 表示の左右反転。 */
#define FP_STATUS_FLAG_FLIP_H 0x01u
/** @brief 状態メッセージのフラグ: 表示の上下反転。 */
#define FP_STATUS_FLAG_FLIP_V 0x02u

/** @brief ログのレベル: 情報。 */
#define FP_LOG_INFO 0u
/** @brief ログのレベル: 警告。 */
#define FP_LOG_WARN 1u
/** @brief ログのレベル: エラー。 */
#define FP_LOG_ERROR 2u

/** @brief 測距フレームの入力。配列はゾーン番号順(ターゲットごとのフィールドは ゾーン × ターゲット数 + ターゲット)。 */
typedef struct {
  /** @brief シーケンス番号。 */
  uint32_t seq;
  /** @brief タイムスタンプ [µs](起動からの時間の下位 32 bit)。 */
  uint32_t timestamp_us;
  /** @brief 一辺のゾーン数(4 または 8)。 */
  uint8_t side;
  /** @brief ゾーンあたりターゲット数(1〜FP_MAX_TARGETS)。 */
  uint8_t targets_per_zone;
  /** @brief 含めるフィールドのビットマスク(FP_FIELD_*)。 */
  uint16_t field_mask;
  /** @brief センサーの温度 [℃]。 */
  int8_t temperature_c;
  /** @brief 距離 [mm]。FP_FIELD_DISTANCE を含むときに使う。 */
  const int16_t *distance_mm;
  /** @brief 測距ステータス。FP_FIELD_TARGET_STATUS を含むときに使う。 */
  const uint8_t *target_status;
  /** @brief sigma [mm]。FP_FIELD_RANGE_SIGMA を含むときに使う。 */
  const uint16_t *range_sigma_mm;
  /** @brief ターゲット数(ゾーンごと)。FP_FIELD_NB_TARGET を含むときに使う。 */
  const uint8_t *nb_target_detected;
  /** @brief 信号強度 [kcps/SPAD]。FP_FIELD_SIGNAL を含むときに使う。 */
  const uint32_t *signal_per_spad;
  /** @brief 有効 SPAD 数(ゾーンごと)。FP_FIELD_NB_SPADS を含むときに使う。 */
  const uint32_t *nb_spads_enabled;
} fp_frame_t;

/** @brief 状態メッセージの入力。 */
typedef struct {
  /** @brief シーケンス番号。 */
  uint32_t seq;
  /** @brief タイムスタンプ [µs]。 */
  uint32_t timestamp_us;
  /** @brief 一辺のゾーン数(4 または 8)。 */
  uint8_t side;
  /** @brief ゾーンあたりターゲット数(1〜FP_MAX_TARGETS)。 */
  uint8_t targets_per_zone;
  /** @brief 測距フレームに含めるフィールドのビットマスク。 */
  uint16_t field_mask;
  /** @brief 測距の頻度 [Hz]。 */
  uint8_t ranging_hz;
  /** @brief FP_STATUS_FLAG_* の組み合わせ。 */
  uint8_t flags;
  /** @brief I2C の実際のクロック [Hz]。 */
  uint32_t i2c_hz;
  /** @brief センサーから 1 フレームで読むバイト数(ULD の data_read_size)。 */
  uint32_t sensor_read_bytes;
  /** @brief ファームウェアの版の文字列(NUL 終端、ASCII)。 */
  const char *firmware_version;
} fp_status_t;

/**
 * @brief CRC-32(IEEE 802.3、反転あり、初期値 0xFFFFFFFF、最終 XOR 0xFFFFFFFF)を計算する。"123456789" で 0xCBF43926。
 * @param data 対象
 * @param len バイト数
 * @return CRC-32
 */
uint32_t fp_crc32(const uint8_t *data, size_t len);

/**
 * @brief 測距フレームのペイロードの長さ(ヘッダ + マスクに含むフィールドの配列の合計)を返す。
 * @param side 一辺のゾーン数
 * @param targets_per_zone ゾーンあたりターゲット数
 * @param field_mask フィールドマスク
 * @return ペイロードのバイト数。side / targets_per_zone / field_mask が版 1 の範囲外なら 0
 */
size_t fp_frame_payload_len(uint8_t side, uint8_t targets_per_zone, uint16_t field_mask);

/**
 * @brief 測距フレームのペイロードを組み立てる。
 *
 * 次の場合は何も書かずに 0 を返す: side が 4 / 8 以外、targets_per_zone が 1〜FP_MAX_TARGETS の外、field_mask に
 * FP_FIELDS_KNOWN 以外のビットがある、マスクに含むフィールドの配列が NULL、容量不足。
 * @param buf 出力先
 * @param cap buf のバイト数
 * @param f 入力
 * @return 書いたバイト数
 */
size_t fp_build_frame(uint8_t *buf, size_t cap, const fp_frame_t *f);

/**
 * @brief ログのペイロードを組み立てる。
 *
 * 文字列は FP_LOG_TEXT_MAX バイトで切り詰め、0x20〜0x7E 以外のバイトは '?' に置き換える。
 * level が FP_LOG_ERROR より大きい、または容量不足なら何も書かずに 0 を返す。
 * @param buf 出力先
 * @param cap buf のバイト数
 * @param seq シーケンス番号
 * @param timestamp_us タイムスタンプ [µs]
 * @param level FP_LOG_*
 * @param text NUL 終端の文字列
 * @return 書いたバイト数
 */
size_t fp_build_log(uint8_t *buf, size_t cap, uint32_t seq, uint32_t timestamp_us, uint8_t level, const char *text);

/**
 * @brief 状態のペイロードを組み立てる。
 *
 * 版の文字列は FP_VERSION_TEXT_MAX バイトで切り詰め、0x20〜0x7E 以外のバイトは '?' に置き換える。
 * side / targets_per_zone / field_mask が fp_build_frame() と同じ範囲外、flags に未定義のビットがある、容量不足の
 * 場合は何も書かずに 0 を返す。
 * @param buf 出力先
 * @param cap buf のバイト数
 * @param s 入力
 * @return 書いたバイト数
 */
size_t fp_build_status(uint8_t *buf, size_t cap, const fp_status_t *s);

/**
 * @brief buf の先頭 len バイトの CRC-32 を、その後ろにリトルエンディアンで書く。
 * @param buf ペイロード(後ろに 4 バイトの空きが要る)
 * @param len ペイロードのバイト数
 * @param cap buf のバイト数
 * @return len + 4。容量不足なら何も書かずに 0
 */
size_t fp_append_crc32(uint8_t *buf, size_t len, size_t cap);

/**
 * @brief COBS でエンコードする(区切りの 0x00 は付けない)。
 *
 * 254 バイトの非ゼロのかたまりで入力が終わる場合、最後に 0x01 を付けない(docs/frame-format.md の定義)。
 * @param dst 出力先
 * @param cap dst のバイト数(FP_COBS_MAX(len) 以上が要る)
 * @param src 入力
 * @param len 入力のバイト数(0 可)
 * @return 書いたバイト数。容量が FP_COBS_MAX(len) 未満なら何も書かずに 0
 */
size_t fp_cobs_encode(uint8_t *dst, size_t cap, const uint8_t *src, size_t len);

/**
 * @brief COBS をデコードする(区切りの 0x00 を含まない 1 パケット分)。
 * @param dst 出力先
 * @param cap dst のバイト数
 * @param src 入力
 * @param len 入力のバイト数
 * @param out_len デコードしたバイト数の格納先
 * @return 成功で true。入力が空、0x00 を含む、コードが入力の終わりを越える、容量不足なら false
 */
bool fp_cobs_decode(uint8_t *dst, size_t cap, const uint8_t *src, size_t len, size_t *out_len);

/**
 * @brief USB シリアルのリンク層: packet(ペイロード + CRC)を COBS にし、区切りの 0x00 を付けて dst に書く。
 * @param dst 出力先
 * @param cap dst のバイト数(FP_COBS_MAX(len) + 1 以上が要る)
 * @param packet ペイロード + CRC
 * @param len packet のバイト数
 * @return 書いたバイト数(0x00 を含む)。容量不足なら 0
 */
size_t fp_cobs_frame(uint8_t *dst, size_t cap, const uint8_t *packet, size_t len);

#endif // FRAME_PROTO_H
