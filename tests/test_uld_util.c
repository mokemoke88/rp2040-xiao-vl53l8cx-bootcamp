/* SPDX-License-Identifier: MIT */
/* uld_util の単体テスト。入力と期待値の対応は tests/CASES.md を参照 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "uld_util.h"
#include "unity.h"

/* 分割書き込みの塊の長さ。make test は既定値(256)と小さい値(7)の両方でビルドして実行する */
#define CHUNK ULD_WRITE_CHUNK_BYTES

/* 塊の数(切り上げ) */
#define CHUNKS_FOR(total) (((total) + CHUNK - 1u) / CHUNK)

/* 書き込みの模擬に使うレジスタ空間(16 bit アドレス全体)と、書き込む元データ */
static uint8_t regs[0x10000];
static uint8_t src[0x8000];
static uint8_t packet[ULD_REG_ADDR_BYTES + ULD_WRITE_CHUNK_BYTES];

void setUp(void) {}

void tearDown(void) {}

/* ---- uld_swap_buffer ---- */

static void test_swap_reverses_each_4_bytes(void) {
  uint8_t buf[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  const uint8_t expected[8] = {4, 3, 2, 1, 8, 7, 6, 5};
  uld_swap_buffer(buf, 8);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, buf, 8);
}

static void test_swap_twice_restores(void) {
  uint8_t buf[12];
  uint8_t orig[12];
  for (uint32_t i = 0; i < 12; i++) buf[i] = orig[i] = (uint8_t)(0xA0u + i);
  uld_swap_buffer(buf, 12);
  uld_swap_buffer(buf, 12);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(orig, buf, 12);
}

static void test_swap_size_zero_changes_nothing(void) {
  uint8_t buf[4] = {1, 2, 3, 4};
  const uint8_t expected[4] = {1, 2, 3, 4};
  uld_swap_buffer(buf, 0);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, buf, 4);
}

static void test_swap_leaves_remainder_and_outside(void) {
  /* size = 6: 先頭 4 バイトだけ反転し、余りの 2 バイトと size の外(2 バイト)は変えない */
  uint8_t buf[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  const uint8_t expected[8] = {4, 3, 2, 1, 5, 6, 7, 8};
  uld_swap_buffer(buf, 6);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, buf, 8);
}

static void test_swap_big_endian_word_to_value(void) {
  /* ULD のファームウェアのチェックサム比較と同じ使い方: センサーが上位バイトから送る 0x0C0B6C9E を反転すると、
     リトルエンディアンの並び(最下位バイトが先頭)になる。ホストのエンディアンによらないようにバイトから組み立てる */
  uint8_t buf[4] = {0x0C, 0x0B, 0x6C, 0x9E};
  uld_swap_buffer(buf, 4);
  const uint32_t value =
      (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) | ((uint32_t)buf[2] << 16) | ((uint32_t)buf[3] << 24);
  TEST_ASSERT_EQUAL_HEX32(0x0C0B6C9Eu, value);
}

/* ---- uld_chunk_len / uld_chunk_reg ---- */

static void test_chunk_len_zero_total(void) {
  TEST_ASSERT_EQUAL_UINT32(0, uld_chunk_len(0, 0, CHUNK));
}

static void test_chunk_len_exact_chunk(void) {
  TEST_ASSERT_EQUAL_UINT32(CHUNK, uld_chunk_len(CHUNK, 0, CHUNK));
  TEST_ASSERT_EQUAL_UINT32(0, uld_chunk_len(CHUNK, CHUNK, CHUNK));
}

static void test_chunk_len_one_over(void) {
  TEST_ASSERT_EQUAL_UINT32(CHUNK, uld_chunk_len(CHUNK + 1u, 0, CHUNK));
  TEST_ASSERT_EQUAL_UINT32(1, uld_chunk_len(CHUNK + 1u, CHUNK, CHUNK));
  TEST_ASSERT_EQUAL_UINT32(0, uld_chunk_len(CHUNK + 1u, CHUNK + 1u, CHUNK));
}

static void test_chunk_len_shorter_than_chunk(void) {
  TEST_ASSERT_EQUAL_UINT32(1, uld_chunk_len(1, 0, CHUNK));
}

static void test_chunk_len_offset_past_total(void) {
  TEST_ASSERT_EQUAL_UINT32(0, uld_chunk_len(10, 11, CHUNK));
}

static void test_chunk_reg_adds_offset(void) {
  TEST_ASSERT_EQUAL_HEX16(0x2C34u, uld_chunk_reg(0x2C34u, 0));
  TEST_ASSERT_EQUAL_HEX16(0x2C34u + 972u, uld_chunk_reg(0x2C34u, 972u));
  TEST_ASSERT_EQUAL_HEX16(0x7FFFu, uld_chunk_reg(0, 0x7FFFu));
}

static void test_chunk_reg_truncates_to_16_bits(void) {
  TEST_ASSERT_EQUAL_HEX16(0x0000u, uld_chunk_reg(0xFFFFu, 1u));
}

/* ---- uld_pack_write ---- */

static void test_pack_write_address_big_endian(void) {
  uint8_t buf[6];
  memset(buf, 0xEE, sizeof buf);
  const uint8_t data[3] = {0x11, 0x22, 0x33};
  const uint8_t expected[6] = {0x2E, 0x18, 0x11, 0x22, 0x33, 0xEE};
  TEST_ASSERT_EQUAL_UINT32(5, uld_pack_write(buf, 0x2E18u, data, 3));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, buf, 6);
}

static void test_pack_write_no_data(void) {
  uint8_t buf[3] = {0xEE, 0xEE, 0xEE};
  const uint8_t expected[3] = {0x81, 0x2F, 0xEE};
  TEST_ASSERT_EQUAL_UINT32(ULD_REG_ADDR_BYTES, uld_pack_write(buf, 0x812Fu, NULL, 0));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, buf, 3);
}

/* ---- 分割書き込み(uld_write_chunked) ----
   send に「塊の先頭 2 バイトのアドレスから 1 バイトずつアドレスを進めて書くセンサー」の模擬を渡す。
   書き込み全体が元データと一致し、範囲外が変わらないこと、失敗した塊の後は送らないことを確かめる */

/* 模擬センサーの状態 */
static uint32_t send_calls; /* send が呼ばれた回数 */
static uint32_t fail_at_call; /* この番号(0 始まり)の呼び出しで失敗を返す。NO_FAIL なら失敗しない */
#define NO_FAIL UINT32_MAX

/* 模擬センサー: 塊の長さを検査し、先頭 2 バイトをアドレスとして残りを順に書く。fail_at_call 番目は書かずに失敗する */
static bool fake_send(void *ctx, const uint8_t *pkt, uint32_t len) {
  TEST_ASSERT_EQUAL_PTR(regs, ctx);
  TEST_ASSERT_TRUE(len >= ULD_REG_ADDR_BYTES + 1u && len <= ULD_REG_ADDR_BYTES + CHUNK);
  const uint32_t call = send_calls++;
  if (call == fail_at_call) return false;
  uint16_t reg = (uint16_t)(((uint16_t)pkt[0] << 8) | pkt[1]);
  for (uint32_t i = ULD_REG_ADDR_BYTES; i < len; i++) regs[reg++] = pkt[i];
  return true;
}

/* 元データを作り、レジスタ空間を目印の値 0xEE で埋め、呼び出し回数を 0 にする */
static void prepare(uint32_t size, uint32_t fail_at) {
  for (uint32_t i = 0; i < size; i++) src[i] = (uint8_t)(i * 7u + (i >> 8) + 1u);
  memset(regs, 0xEE, sizeof regs);
  send_calls = 0;
  fail_at_call = fail_at;
}

/* 最後まで成功する分割書き込みを行い、結果を検査する */
static void check_wrmulti(uint16_t start_reg, uint32_t size) {
  prepare(size, NO_FAIL);

  TEST_ASSERT_TRUE(uld_write_chunked(start_reg, src, size, packet, CHUNK, fake_send, regs));

  TEST_ASSERT_EQUAL_UINT32(CHUNKS_FOR(size), send_calls);
  if (size > 0u) TEST_ASSERT_EQUAL_UINT8_ARRAY(src, &regs[start_reg], size);
  /* 書き込み範囲の直前と直後は変わらない */
  if (start_reg > 0u) TEST_ASSERT_EQUAL_HEX8(0xEE, regs[start_reg - 1u]);
  if ((uint32_t)start_reg + size < sizeof regs) TEST_ASSERT_EQUAL_HEX8(0xEE, regs[start_reg + size]);
}

/* fail_at 番目の塊で失敗させ、false が返り、そこで送るのをやめ、失敗より前の塊だけが書かれていることを検査する */
static void check_wrmulti_fails_at(uint16_t start_reg, uint32_t size, uint32_t fail_at) {
  prepare(size, fail_at);

  TEST_ASSERT_FALSE(uld_write_chunked(start_reg, src, size, packet, CHUNK, fake_send, regs));

  TEST_ASSERT_EQUAL_UINT32(fail_at + 1u, send_calls);
  const uint32_t written = fail_at * CHUNK;
  if (written > 0u) TEST_ASSERT_EQUAL_UINT8_ARRAY(src, &regs[start_reg], written);
  for (uint32_t i = written; i < size; i++) TEST_ASSERT_EQUAL_HEX8(0xEE, regs[start_reg + i]);
}

static void test_wrmulti_first_chunk_fails(void) {
  check_wrmulti_fails_at(0x0000u, 3u * CHUNK + 1u, 0);
}

static void test_wrmulti_middle_chunk_fails(void) {
  check_wrmulti_fails_at(0x0000u, 3u * CHUNK + 1u, 1);
}

static void test_wrmulti_last_chunk_fails(void) {
  /* 4 塊目(端数の 1 バイト)で失敗 */
  check_wrmulti_fails_at(0x0000u, 3u * CHUNK + 1u, 3);
}

static void test_wrmulti_zero_max_chunk_fails(void) {
  prepare(4, NO_FAIL);
  TEST_ASSERT_FALSE(uld_write_chunked(0x0000u, src, 4, packet, 0, fake_send, regs));
  TEST_ASSERT_EQUAL_UINT32(0, send_calls);
}

static void test_wrmulti_zero_bytes_sends_nothing(void) {
  check_wrmulti(0x2C34u, 0);
  TEST_ASSERT_EQUAL_UINT32(0, send_calls);
}

static void test_wrmulti_one_byte(void) {
  check_wrmulti(0x7FFFu, 1);
}

static void test_wrmulti_exact_chunk(void) {
  check_wrmulti(0x2E18u, CHUNK);
}

static void test_wrmulti_chunk_plus_remainder(void) {
  check_wrmulti(0x2E18u, CHUNK + 1u);
}

static void test_wrmulti_firmware_page_0x8000(void) {
  /* ファームウェア転送の 1 ページ(アドレス 0 から 0x8000 バイト) */
  check_wrmulti(0x0000u, 0x8000u);
}

static void test_wrmulti_firmware_last_page_0x5000(void) {
  check_wrmulti(0x0000u, 0x5000u);
}

static void test_wrmulti_default_configuration(void) {
  /* 既定の設定(VL53L8CX_CONFIGURATION_SIZE = 972 バイト)を 0x2C34 から */
  check_wrmulti(0x2C34u, 972u);
}

/* ---- uld_i2c_timeout_us ---- */

static void test_timeout_zero_bytes_is_base(void) {
  TEST_ASSERT_EQUAL_UINT32(ULD_I2C_TIMEOUT_BASE_US, uld_i2c_timeout_us(0));
}

static void test_timeout_grows_per_byte(void) {
  TEST_ASSERT_EQUAL_UINT32(ULD_I2C_TIMEOUT_BASE_US + 2u * ULD_I2C_TIMEOUT_PER_BYTE_US, uld_i2c_timeout_us(2));
  TEST_ASSERT_EQUAL_UINT32(ULD_I2C_TIMEOUT_BASE_US + 258u * ULD_I2C_TIMEOUT_PER_BYTE_US, uld_i2c_timeout_us(258));
}

static void test_timeout_saturates(void) {
  const uint32_t limit = (UINT32_MAX - ULD_I2C_TIMEOUT_BASE_US) / ULD_I2C_TIMEOUT_PER_BYTE_US;
  TEST_ASSERT_EQUAL_UINT32(ULD_I2C_TIMEOUT_BASE_US + limit * ULD_I2C_TIMEOUT_PER_BYTE_US, uld_i2c_timeout_us(limit));
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, uld_i2c_timeout_us(limit + 1u));
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, uld_i2c_timeout_us(UINT32_MAX));
}

/* ---- uld_target_status_is_valid ---- */

static void test_status_valid_values(void) {
  TEST_ASSERT_TRUE(uld_target_status_is_valid(5));
  TEST_ASSERT_TRUE(uld_target_status_is_valid(9));
}

static void test_status_invalid_neighbours(void) {
  TEST_ASSERT_FALSE(uld_target_status_is_valid(0));
  TEST_ASSERT_FALSE(uld_target_status_is_valid(4));
  TEST_ASSERT_FALSE(uld_target_status_is_valid(6));
  TEST_ASSERT_FALSE(uld_target_status_is_valid(8));
  TEST_ASSERT_FALSE(uld_target_status_is_valid(10));
  TEST_ASSERT_FALSE(uld_target_status_is_valid(255));
}

static void test_status_only_two_valid(void) {
  uint32_t count = 0;
  for (uint32_t s = 0; s <= 255u; s++) {
    if (uld_target_status_is_valid((uint8_t)s)) count++;
  }
  TEST_ASSERT_EQUAL_UINT32(2, count);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_swap_reverses_each_4_bytes);
  RUN_TEST(test_swap_twice_restores);
  RUN_TEST(test_swap_size_zero_changes_nothing);
  RUN_TEST(test_swap_leaves_remainder_and_outside);
  RUN_TEST(test_swap_big_endian_word_to_value);
  RUN_TEST(test_chunk_len_zero_total);
  RUN_TEST(test_chunk_len_exact_chunk);
  RUN_TEST(test_chunk_len_one_over);
  RUN_TEST(test_chunk_len_shorter_than_chunk);
  RUN_TEST(test_chunk_len_offset_past_total);
  RUN_TEST(test_chunk_reg_adds_offset);
  RUN_TEST(test_chunk_reg_truncates_to_16_bits);
  RUN_TEST(test_pack_write_address_big_endian);
  RUN_TEST(test_pack_write_no_data);
  RUN_TEST(test_wrmulti_zero_bytes_sends_nothing);
  RUN_TEST(test_wrmulti_one_byte);
  RUN_TEST(test_wrmulti_exact_chunk);
  RUN_TEST(test_wrmulti_chunk_plus_remainder);
  RUN_TEST(test_wrmulti_firmware_page_0x8000);
  RUN_TEST(test_wrmulti_firmware_last_page_0x5000);
  RUN_TEST(test_wrmulti_default_configuration);
  RUN_TEST(test_wrmulti_first_chunk_fails);
  RUN_TEST(test_wrmulti_middle_chunk_fails);
  RUN_TEST(test_wrmulti_last_chunk_fails);
  RUN_TEST(test_wrmulti_zero_max_chunk_fails);
  RUN_TEST(test_timeout_zero_bytes_is_base);
  RUN_TEST(test_timeout_grows_per_byte);
  RUN_TEST(test_timeout_saturates);
  RUN_TEST(test_status_valid_values);
  RUN_TEST(test_status_invalid_neighbours);
  RUN_TEST(test_status_only_two_valid);
  return UNITY_END();
}
