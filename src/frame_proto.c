/* SPDX-License-Identifier: MIT */
#include "frame_proto.h"

/** @brief CRC-32(IEEE)の多項式 0x04C11DB7 をビット反転した値。LSB から処理する実装で使う。 */
#define CRC32_POLY_REFLECTED 0xEDB88320u

/** @brief COBS の 1 ブロックの最大コード(0xFF = 254 バイトの非ゼロが続き、ゼロを補わない)。 */
#define COBS_MAX_CODE 0xFFu

/** @brief 状態メッセージのフラグで定義しているビット。 */
#define STATUS_FLAGS_KNOWN (FP_STATUS_FLAG_FLIP_H | FP_STATUS_FLAG_FLIP_V)

/**
 * @brief 書き込み位置と容量を持つ出力。書き込む前に全体の長さを確かめてから使うので、ここでは範囲検査をしない。
 */
typedef struct {
  /** @brief 出力先。 */
  uint8_t *p;
  /** @brief 書いたバイト数。 */
  size_t len;
} wr_t;

/**
 * @brief 1 バイト書く。
 * @param w 出力
 * @param v 値
 */
static void put_u8(wr_t *w, uint8_t v) {
  w->p[w->len++] = v;
}

/**
 * @brief 16 bit をリトルエンディアンで書く。
 * @param w 出力
 * @param v 値
 */
static void put_u16(wr_t *w, uint16_t v) {
  put_u8(w, (uint8_t)(v & 0xFFu));
  put_u8(w, (uint8_t)(v >> 8));
}

/**
 * @brief 32 bit をリトルエンディアンで書く。
 * @param w 出力
 * @param v 値
 */
static void put_u32(wr_t *w, uint32_t v) {
  put_u16(w, (uint16_t)(v & 0xFFFFu));
  put_u16(w, (uint16_t)(v >> 16));
}

/**
 * @brief 全種別に共通のヘッダ(マジック、版、種別、シーケンス番号、タイムスタンプ)を書く。
 * @param w 出力
 * @param type メッセージ種別
 * @param seq シーケンス番号
 * @param timestamp_us タイムスタンプ [µs]
 */
static void put_common_header(wr_t *w, uint8_t type, uint32_t seq, uint32_t timestamp_us) {
  put_u8(w, FP_MAGIC0);
  put_u8(w, FP_MAGIC1);
  put_u8(w, FP_VERSION);
  put_u8(w, type);
  put_u32(w, seq);
  put_u32(w, timestamp_us);
}

/**
 * @brief 文字列の長さ(max で頭打ち)を返す。
 * @param s NUL 終端の文字列
 * @param max 上限
 * @return バイト数
 */
static size_t text_len(const char *s, size_t max) {
  size_t n = 0;
  while (n < max && s[n] != '\0') n++;
  return n;
}

/**
 * @brief 文字列を n バイト書く。印字可能な ASCII(0x20〜0x7E)以外は '?' に置き換える。
 * @param w 出力
 * @param s 文字列
 * @param n バイト数
 */
static void put_text(wr_t *w, const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    const uint8_t c = (uint8_t)s[i];
    put_u8(w, (c >= 0x20u && c <= 0x7Eu) ? c : (uint8_t)'?');
  }
}

/**
 * @brief 辺・ターゲット数・フィールドマスクが版 1 の範囲内かを返す。
 * @param side 一辺のゾーン数
 * @param targets ゾーンあたりターゲット数
 * @param mask フィールドマスク
 * @return 範囲内なら true
 */
static bool shape_ok(uint8_t side, uint8_t targets, uint16_t mask) {
  return (side == 4u || side == 8u) && targets >= 1u && targets <= FP_MAX_TARGETS && (mask & ~FP_FIELDS_KNOWN) == 0u;
}

uint32_t fp_crc32(const uint8_t *data, size_t len) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint32_t b = 0; b < 8u; b++) crc = (crc & 1u) != 0u ? (crc >> 1) ^ CRC32_POLY_REFLECTED : crc >> 1;
  }
  return crc ^ 0xFFFFFFFFu;
}

size_t fp_frame_payload_len(uint8_t side, uint8_t targets_per_zone, uint16_t field_mask) {
  if (!shape_ok(side, targets_per_zone, field_mask)) return 0;
  const size_t zones = (size_t)side * side;
  const size_t per_target = zones * targets_per_zone;
  size_t n = FP_FRAME_HEADER_BYTES;
  if ((field_mask & FP_FIELD_DISTANCE) != 0u) n += per_target * 2u;
  if ((field_mask & FP_FIELD_TARGET_STATUS) != 0u) n += per_target * 1u;
  if ((field_mask & FP_FIELD_RANGE_SIGMA) != 0u) n += per_target * 2u;
  if ((field_mask & FP_FIELD_NB_TARGET) != 0u) n += zones * 1u;
  if ((field_mask & FP_FIELD_SIGNAL) != 0u) n += per_target * 4u;
  if ((field_mask & FP_FIELD_NB_SPADS) != 0u) n += zones * 4u;
  return n;
}

size_t fp_build_frame(uint8_t *buf, size_t cap, const fp_frame_t *f) {
  const size_t n = fp_frame_payload_len(f->side, f->targets_per_zone, f->field_mask);
  if (n == 0u || n > cap) return 0;
  const uint16_t m = f->field_mask;
  if (((m & FP_FIELD_DISTANCE) != 0u && f->distance_mm == NULL) ||
      ((m & FP_FIELD_TARGET_STATUS) != 0u && f->target_status == NULL) ||
      ((m & FP_FIELD_RANGE_SIGMA) != 0u && f->range_sigma_mm == NULL) ||
      ((m & FP_FIELD_NB_TARGET) != 0u && f->nb_target_detected == NULL) ||
      ((m & FP_FIELD_SIGNAL) != 0u && f->signal_per_spad == NULL) ||
      ((m & FP_FIELD_NB_SPADS) != 0u && f->nb_spads_enabled == NULL)) {
    return 0;
  }

  const size_t zones = (size_t)f->side * f->side;
  const size_t per_target = zones * f->targets_per_zone;
  wr_t w = {buf, 0};
  put_common_header(&w, FP_TYPE_FRAME, f->seq, f->timestamp_us);
  put_u8(&w, f->side);
  put_u8(&w, f->targets_per_zone);
  put_u16(&w, m);
  put_u8(&w, (uint8_t)f->temperature_c);
  put_u8(&w, 0u); /* 予約 */

  /* フィールドはマスクのビットの小さい順に、配列ごとまとめて並べる */
  if ((m & FP_FIELD_DISTANCE) != 0u) {
    for (size_t i = 0; i < per_target; i++) put_u16(&w, (uint16_t)f->distance_mm[i]);
  }
  if ((m & FP_FIELD_TARGET_STATUS) != 0u) {
    for (size_t i = 0; i < per_target; i++) put_u8(&w, f->target_status[i]);
  }
  if ((m & FP_FIELD_RANGE_SIGMA) != 0u) {
    for (size_t i = 0; i < per_target; i++) put_u16(&w, f->range_sigma_mm[i]);
  }
  if ((m & FP_FIELD_NB_TARGET) != 0u) {
    for (size_t i = 0; i < zones; i++) put_u8(&w, f->nb_target_detected[i]);
  }
  if ((m & FP_FIELD_SIGNAL) != 0u) {
    for (size_t i = 0; i < per_target; i++) put_u32(&w, f->signal_per_spad[i]);
  }
  if ((m & FP_FIELD_NB_SPADS) != 0u) {
    for (size_t i = 0; i < zones; i++) put_u32(&w, f->nb_spads_enabled[i]);
  }
  return w.len;
}

size_t fp_build_log(uint8_t *buf, size_t cap, uint32_t seq, uint32_t timestamp_us, uint8_t level, const char *text) {
  const size_t tl = text_len(text, FP_LOG_TEXT_MAX);
  const size_t n = FP_LOG_HEADER_BYTES + tl;
  if (level > FP_LOG_ERROR || n > cap) return 0;
  wr_t w = {buf, 0};
  put_common_header(&w, FP_TYPE_LOG, seq, timestamp_us);
  put_u8(&w, level);
  put_u8(&w, 0u); /* 予約 */
  put_u16(&w, (uint16_t)tl);
  put_text(&w, text, tl);
  return w.len;
}

size_t fp_build_status(uint8_t *buf, size_t cap, const fp_status_t *s) {
  const size_t vl = text_len(s->firmware_version, FP_VERSION_TEXT_MAX);
  const size_t n = FP_STATUS_HEADER_BYTES + vl;
  if (!shape_ok(s->side, s->targets_per_zone, s->field_mask) || (s->flags & ~STATUS_FLAGS_KNOWN) != 0u || n > cap) {
    return 0;
  }
  wr_t w = {buf, 0};
  put_common_header(&w, FP_TYPE_STATUS, s->seq, s->timestamp_us);
  put_u8(&w, s->side);
  put_u8(&w, s->targets_per_zone);
  put_u16(&w, s->field_mask);
  put_u8(&w, s->ranging_hz);
  put_u8(&w, s->flags);
  put_u32(&w, s->i2c_hz);
  put_u32(&w, s->sensor_read_bytes);
  put_u8(&w, (uint8_t)vl);
  put_text(&w, s->firmware_version, vl);
  return w.len;
}

size_t fp_append_crc32(uint8_t *buf, size_t len, size_t cap) {
  if (cap < FP_CRC_BYTES || len > cap - FP_CRC_BYTES) return 0;
  wr_t w = {buf, len};
  put_u32(&w, fp_crc32(buf, len));
  return w.len;
}

size_t fp_cobs_encode(uint8_t *dst, size_t cap, const uint8_t *src, size_t len) {
  if (cap < FP_COBS_MAX(len)) return 0;
  /* code_at: いま作っているブロックのコード(次のゼロまたはブロック末尾までの距離)を書く位置 */
  size_t code_at = 0;
  size_t out = 1;
  uint8_t code = 1;
  for (size_t i = 0; i < len; i++) {
    if (src[i] == 0u) {
      /* ゼロはデータに書かず、ブロックを閉じる(コードが「ここにゼロがあった」ことを表す) */
      dst[code_at] = code;
      code_at = out++;
      code = 1;
      continue;
    }
    dst[out++] = src[i];
    code++;
    if (code == COBS_MAX_CODE) {
      /* 254 バイトの非ゼロでブロックが満杯。入力がここで終わるなら次のブロックを作らない */
      dst[code_at] = code;
      code = 1;
      if (i + 1u == len) return out;
      code_at = out++;
    }
  }
  dst[code_at] = code;
  return out;
}

bool fp_cobs_decode(uint8_t *dst, size_t cap, const uint8_t *src, size_t len, size_t *out_len) {
  if (len == 0u) return false;
  size_t in = 0;
  size_t out = 0;
  while (in < len) {
    const uint8_t code = src[in++];
    if (code == 0u) return false;
    const size_t run = (size_t)code - 1u;
    if (run > len - in) return false;
    if (run > cap - out) return false;
    for (size_t k = 0; k < run; k++) {
      if (src[in] == 0u) return false;
      dst[out++] = src[in++];
    }
    /* 0xFF 以外のブロックの後ろにはゼロがある。ただし入力の最後のブロックの後ろは除く */
    if (code != COBS_MAX_CODE && in < len) {
      if (out >= cap) return false;
      dst[out++] = 0u;
    }
  }
  *out_len = out;
  return true;
}

size_t fp_cobs_frame(uint8_t *dst, size_t cap, const uint8_t *packet, size_t len) {
  if (cap < FP_COBS_MAX(len) + 1u) return 0;
  const size_t n = fp_cobs_encode(dst, cap - 1u, packet, len);
  dst[n] = 0u;
  return n + 1u;
}
