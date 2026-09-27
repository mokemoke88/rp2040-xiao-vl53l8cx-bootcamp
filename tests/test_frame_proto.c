/* SPDX-License-Identifier: MIT */
/* frame_proto の単体テスト。入力と期待値の対応は tests/CASES.md、テストベクタは docs/frame-vectors.json
   (tests/frame_vectors.h は同じ内容を tools/gen_frame_vectors.py が C の配列にしたもの) */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "frame_proto.h"
#include "frame_vectors.h"
#include "unity.h"

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

/* 出力先。後ろに容量外の検査用の余分を持つ */
#define CANARY_BYTES 16u
static uint8_t out[FP_SERIAL_MAX + CANARY_BYTES];
static uint8_t payload[FP_PAYLOAD_MAX + FP_CRC_BYTES + CANARY_BYTES];
static uint8_t decoded[FP_PAYLOAD_MAX + FP_CRC_BYTES + CANARY_BYTES];

void setUp(void) {}

void tearDown(void) {}

/* buf[from..from+CANARY_BYTES) が 0xA5 のままかを検査する */
static void check_canary(const uint8_t *buf, size_t from) {
  for (size_t k = 0; k < CANARY_BYTES; k++) TEST_ASSERT_EQUAL_HEX8(0xA5, buf[from + k]);
}

/* ---- CRC-32 ---- */

static void test_crc32_check_value(void) {
  const uint8_t s[] = "123456789";
  TEST_ASSERT_EQUAL_HEX32(0xCBF43926u, fp_crc32(s, 9));
  TEST_ASSERT_EQUAL_HEX32(FV_CRC32_CHECK, fp_crc32(s, 9));
}

static void test_crc32_empty_and_single(void) {
  TEST_ASSERT_EQUAL_HEX32(0x00000000u, fp_crc32(NULL, 0));
  const uint8_t z = 0;
  TEST_ASSERT_EQUAL_HEX32(0xD202EF8Du, fp_crc32(&z, 1));
}

static void test_append_crc32_little_endian(void) {
  memset(payload, 0xA5, sizeof payload);
  memcpy(payload, "123456789", 9);
  TEST_ASSERT_EQUAL_size_t(13, fp_append_crc32(payload, 9, 13));
  const uint8_t expected[4] = {0x26, 0x39, 0xF4, 0xCB};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, &payload[9], 4);
  check_canary(payload, 13);
  /* 容量が足りなければ何も書かない */
  memset(payload, 0xA5, sizeof payload);
  TEST_ASSERT_EQUAL_size_t(0, fp_append_crc32(payload, 9, 12));
  TEST_ASSERT_EQUAL_size_t(0, fp_append_crc32(payload, 0, 3));
  check_canary(payload, 0);
}

/* ---- COBS ---- */

static void test_cobs_vectors_encode(void) {
  for (size_t i = 0; i < COUNT(FV_COBS); i++) {
    const fv_cobs_t *v = &FV_COBS[i];
    memset(out, 0xA5, sizeof out);
    const size_t n = fp_cobs_encode(out, FP_COBS_MAX(v->decoded_len), v->decoded, v->decoded_len);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(v->encoded_len, n, v->name);
    TEST_ASSERT_EQUAL_UINT8_ARRAY_MESSAGE(v->encoded, out, n, v->name);
    /* 符号化した結果に 0x00 は現れない */
    for (size_t k = 0; k < n; k++) TEST_ASSERT_NOT_EQUAL_MESSAGE(0, out[k], v->name);
    check_canary(out, FP_COBS_MAX(v->decoded_len));
  }
}

static void test_cobs_vectors_decode(void) {
  for (size_t i = 0; i < COUNT(FV_COBS); i++) {
    const fv_cobs_t *v = &FV_COBS[i];
    memset(decoded, 0xA5, sizeof decoded);
    size_t n = 12345;
    TEST_ASSERT_TRUE_MESSAGE(fp_cobs_decode(decoded, v->decoded_len, v->encoded, v->encoded_len, &n), v->name);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(v->decoded_len, n, v->name);
    if (n > 0u) TEST_ASSERT_EQUAL_UINT8_ARRAY_MESSAGE(v->decoded, decoded, n, v->name);
    check_canary(decoded, v->decoded_len);
  }
}

static void test_cobs_max_length_bound(void) {
  /* 0x00 を含まない入力(最も長くなる)で、長さが n + ceil(n / 254)(n = 0 は 1)になり、FP_COBS_MAX 以下 */
  static uint8_t src[FP_PAYLOAD_MAX + FP_CRC_BYTES];
  memset(src, 0x42, sizeof src);
  static const size_t lens[] = {0, 1, 253, 254, 255, 507, 508, 509, 662, sizeof src};
  for (size_t i = 0; i < COUNT(lens); i++) {
    const size_t len = lens[i];
    const size_t n = fp_cobs_encode(out, sizeof out, src, len);
    const size_t exact = len == 0u ? 1u : len + (len + 253u) / 254u;
    TEST_ASSERT_EQUAL_size_t(exact, n);
    TEST_ASSERT_TRUE(n <= FP_COBS_MAX(len));
  }
  TEST_ASSERT_TRUE(FP_COBS_MAX(FP_PAYLOAD_MAX + FP_CRC_BYTES) + 1u <= FP_SERIAL_MAX);
}

static void test_cobs_encode_rejects_small_buffer(void) {
  const uint8_t src[4] = {1, 2, 3, 4};
  memset(out, 0xA5, sizeof out);
  TEST_ASSERT_EQUAL_size_t(0, fp_cobs_encode(out, FP_COBS_MAX(4u) - 1u, src, 4));
  check_canary(out, 0);
}

static void test_cobs_decode_rejects_invalid(void) {
  size_t n = 0;
  /* 空、コードが入力の終わりを越える、入力の途中に 0x00、コード自体が 0x00 */
  const uint8_t past_end[] = {0x05, 0x11, 0x22};
  const uint8_t zero_inside[] = {0x03, 0x11, 0x00};
  const uint8_t zero_code[] = {0x02, 0x11, 0x00, 0x22};
  TEST_ASSERT_FALSE(fp_cobs_decode(decoded, sizeof decoded, past_end, 0, &n));
  TEST_ASSERT_FALSE(fp_cobs_decode(decoded, sizeof decoded, past_end, sizeof past_end, &n));
  TEST_ASSERT_FALSE(fp_cobs_decode(decoded, sizeof decoded, zero_inside, sizeof zero_inside, &n));
  TEST_ASSERT_FALSE(fp_cobs_decode(decoded, sizeof decoded, zero_code, sizeof zero_code, &n));
}

static void test_cobs_decode_accepts_trailing_01(void) {
  /* 254 バイトのブロックの後ろに余分な 0x01 がある(正規でない)符号化も同じ結果になる */
  static uint8_t enc[256];
  enc[0] = 0xFF;
  for (size_t i = 0; i < 254u; i++) enc[1u + i] = (uint8_t)(i + 1u);
  enc[255] = 0x01;
  size_t n = 0;
  TEST_ASSERT_TRUE(fp_cobs_decode(decoded, sizeof decoded, enc, sizeof enc, &n));
  TEST_ASSERT_EQUAL_size_t(254, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(&enc[1], decoded, 254);
}

static void test_cobs_decode_rejects_small_buffer(void) {
  const fv_cobs_t *v = &FV_COBS[3]; /* zero_in_middle: 4 バイト */
  size_t n = 0;
  TEST_ASSERT_EQUAL_STRING("zero_in_middle", v->name);
  TEST_ASSERT_FALSE(fp_cobs_decode(decoded, v->decoded_len - 1u, v->encoded, v->encoded_len, &n));
}

static void test_cobs_frame_appends_delimiter(void) {
  const uint8_t src[3] = {0x11, 0x00, 0x22};
  memset(out, 0xA5, sizeof out);
  const size_t n = fp_cobs_frame(out, sizeof out, src, sizeof src);
  const uint8_t expected[5] = {0x02, 0x11, 0x02, 0x22, 0x00};
  TEST_ASSERT_EQUAL_size_t(5, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, out, 5);
  TEST_ASSERT_EQUAL_size_t(0, fp_cobs_frame(out, FP_COBS_MAX(3u), src, sizeof src));
}

/* ---- メッセージ(テストベクタ) ---- */

/* ベクタの入力から C の実装でペイロードを組み立てる */
static size_t build_from_vector(const fv_message_t *v, uint8_t *buf, size_t cap) {
  if (v->type == FP_TYPE_FRAME) {
    const fp_frame_t f = {v->seq,
                          v->timestamp_us,
                          v->side,
                          v->targets_per_zone,
                          v->field_mask,
                          v->temperature_c,
                          v->distance_mm,
                          v->target_status,
                          v->range_sigma_mm,
                          v->nb_target_detected,
                          v->signal_per_spad,
                          v->nb_spads_enabled};
    return fp_build_frame(buf, cap, &f);
  }
  if (v->type == FP_TYPE_LOG) return fp_build_log(buf, cap, v->seq, v->timestamp_us, v->level, v->text);
  const fp_status_t s = {v->seq,        v->timestamp_us, v->side,   v->targets_per_zone,  v->field_mask,
                         v->ranging_hz, v->flags,        v->i2c_hz, v->sensor_read_bytes, v->firmware_version};
  return fp_build_status(buf, cap, &s);
}

static void test_message_vectors_match(void) {
  for (size_t i = 0; i < COUNT(FV_MESSAGES); i++) {
    const fv_message_t *v = &FV_MESSAGES[i];
    memset(payload, 0xA5, sizeof payload);
    const size_t n = build_from_vector(v, payload, FP_PAYLOAD_MAX);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(v->payload_len, n, v->name);
    TEST_ASSERT_EQUAL_UINT8_ARRAY_MESSAGE(v->payload, payload, n, v->name);
    TEST_ASSERT_EQUAL_HEX32_MESSAGE(v->crc32, fp_crc32(payload, n), v->name);
    if (v->type == FP_TYPE_FRAME) {
      TEST_ASSERT_EQUAL_size_t_MESSAGE(n, fp_frame_payload_len(v->side, v->targets_per_zone, v->field_mask), v->name);
    }

    const size_t m = fp_append_crc32(payload, n, sizeof payload);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(n + 4u, m, v->name);
    memset(out, 0xA5, sizeof out);
    const size_t k = fp_cobs_frame(out, FP_SERIAL_MAX, payload, m);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(v->serial_len, k, v->name);
    TEST_ASSERT_EQUAL_UINT8_ARRAY_MESSAGE(v->serial, out, k, v->name);
    TEST_ASSERT_TRUE_MESSAGE(k <= FP_SERIAL_MAX, v->name);
    check_canary(out, FP_SERIAL_MAX);

    /* 区切りの手前までをデコードすると、ペイロード + CRC に戻る */
    size_t d = 0;
    TEST_ASSERT_TRUE_MESSAGE(fp_cobs_decode(decoded, sizeof decoded, out, k - 1u, &d), v->name);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(m, d, v->name);
    TEST_ASSERT_EQUAL_UINT8_ARRAY_MESSAGE(payload, decoded, d, v->name);
  }
}

static void test_message_exact_capacity(void) {
  /* ちょうどの容量なら書け、1 バイト足りなければ何も書かない */
  for (size_t i = 0; i < COUNT(FV_MESSAGES); i++) {
    const fv_message_t *v = &FV_MESSAGES[i];
    memset(payload, 0xA5, sizeof payload);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(0, build_from_vector(v, payload, v->payload_len - 1u), v->name);
    check_canary(payload, 0);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(v->payload_len, build_from_vector(v, payload, v->payload_len), v->name);
    check_canary(payload, v->payload_len);
  }
}

/* ---- 組み立ての入力検査 ---- */

static int16_t dist[64];
static uint8_t st[64];
static uint16_t sg[64];
static uint8_t nt[64];
static uint32_t sig[64];
static uint32_t spads[64];

static fp_frame_t valid_frame(void) {
  const fp_frame_t f = {1, 2, 8, 1, 0x3Fu, 0, dist, st, sg, nt, sig, spads};
  return f;
}

static void test_frame_rejects_bad_shape(void) {
  fp_frame_t f = valid_frame();
  TEST_ASSERT_EQUAL_size_t(18u + 64u * 14u, fp_build_frame(payload, sizeof payload, &f));
  f.side = 5;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_frame(payload, sizeof payload, &f));
  f = valid_frame();
  f.targets_per_zone = 0;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_frame(payload, sizeof payload, &f));
  f.targets_per_zone = FP_MAX_TARGETS + 1u;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_frame(payload, sizeof payload, &f));
  f = valid_frame();
  f.field_mask = 0x40u; /* 予約ビット */
  TEST_ASSERT_EQUAL_size_t(0, fp_build_frame(payload, sizeof payload, &f));
  TEST_ASSERT_EQUAL_size_t(0, fp_frame_payload_len(8, 1, 0x8000u));
}

static void test_frame_rejects_missing_array(void) {
  fp_frame_t f = valid_frame();
  f.signal_per_spad = NULL;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_frame(payload, sizeof payload, &f));
  /* マスクに含まないフィールドは NULL でよい */
  f.field_mask = 0x0Fu;
  TEST_ASSERT_EQUAL_size_t(18u + 64u * 6u, fp_build_frame(payload, sizeof payload, &f));
  f = valid_frame();
  f.nb_spads_enabled = NULL;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_frame(payload, sizeof payload, &f));
  f = valid_frame();
  f.distance_mm = NULL;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_frame(payload, sizeof payload, &f));
}

static void test_frame_max_payload_fits(void) {
  /* 8x8、4 ターゲット、全フィールドが FP_FRAME_PAYLOAD_MAX ちょうど */
  TEST_ASSERT_EQUAL_size_t(FP_FRAME_PAYLOAD_MAX, fp_frame_payload_len(8, FP_MAX_TARGETS, FP_FIELDS_KNOWN));
  static int16_t d4[256];
  static uint8_t s4[256];
  static uint16_t g4[256];
  static uint32_t p4[256];
  const fp_frame_t f = {1, 2, 8, FP_MAX_TARGETS, FP_FIELDS_KNOWN, 0, d4, s4, g4, nt, p4, spads};
  TEST_ASSERT_EQUAL_size_t(FP_FRAME_PAYLOAD_MAX, fp_build_frame(payload, FP_PAYLOAD_MAX, &f));
}

static void test_log_replaces_non_printable(void) {
  const size_t n = fp_build_log(payload, sizeof payload, 5, 6, FP_LOG_WARN, "a\tb\x7f\x1b[0mc");
  /* 入力は 9 バイト(a TAB b DEL ESC [ 0 m c)。TAB / DEL / ESC が '?' になる */
  TEST_ASSERT_EQUAL_size_t(FP_LOG_HEADER_BYTES + 9u, n);
  TEST_ASSERT_EQUAL_UINT8(FP_LOG_WARN, payload[12]);
  TEST_ASSERT_EQUAL_UINT8(9, payload[14]);
  TEST_ASSERT_EQUAL_UINT8(0, payload[15]);
  TEST_ASSERT_EQUAL_MEMORY("a?b??[0mc", &payload[16], 9);
}

static void test_log_rejects_bad_level(void) {
  TEST_ASSERT_EQUAL_size_t(0, fp_build_log(payload, sizeof payload, 5, 6, 3, "x"));
}

static void test_status_rejects_bad_input(void) {
  fp_status_t s = {1, 2, 8, 1, 0x3Fu, 15, 0x03u, 399361u, 972u, "fw"};
  TEST_ASSERT_EQUAL_size_t(FP_STATUS_HEADER_BYTES + 2u, fp_build_status(payload, sizeof payload, &s));
  s.flags = 0x04u;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_status(payload, sizeof payload, &s));
  s.flags = 0;
  s.field_mask = 0x40u;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_status(payload, sizeof payload, &s));
  s.field_mask = 0x3Fu;
  s.side = 6;
  TEST_ASSERT_EQUAL_size_t(0, fp_build_status(payload, sizeof payload, &s));
}

static void test_status_truncates_version(void) {
  char fw[FP_VERSION_TEXT_MAX + 10u];
  memset(fw, 'v', sizeof fw - 1u);
  fw[sizeof fw - 1u] = '\0';
  const fp_status_t s = {1, 2, 4, 1, 0x03u, 10, 0, 1, 2, fw};
  TEST_ASSERT_EQUAL_size_t(FP_STATUS_HEADER_BYTES + FP_VERSION_TEXT_MAX, fp_build_status(payload, sizeof payload, &s));
  TEST_ASSERT_EQUAL_UINT8(FP_VERSION_TEXT_MAX, payload[26]);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_crc32_check_value);
  RUN_TEST(test_crc32_empty_and_single);
  RUN_TEST(test_append_crc32_little_endian);
  RUN_TEST(test_cobs_vectors_encode);
  RUN_TEST(test_cobs_vectors_decode);
  RUN_TEST(test_cobs_max_length_bound);
  RUN_TEST(test_cobs_encode_rejects_small_buffer);
  RUN_TEST(test_cobs_decode_rejects_invalid);
  RUN_TEST(test_cobs_decode_accepts_trailing_01);
  RUN_TEST(test_cobs_decode_rejects_small_buffer);
  RUN_TEST(test_cobs_frame_appends_delimiter);
  RUN_TEST(test_message_vectors_match);
  RUN_TEST(test_message_exact_capacity);
  RUN_TEST(test_frame_rejects_bad_shape);
  RUN_TEST(test_frame_rejects_missing_array);
  RUN_TEST(test_frame_max_payload_fits);
  RUN_TEST(test_log_replaces_non_printable);
  RUN_TEST(test_log_rejects_bad_level);
  RUN_TEST(test_status_rejects_bad_input);
  RUN_TEST(test_status_truncates_version);
  return UNITY_END();
}
