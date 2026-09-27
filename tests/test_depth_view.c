/* SPDX-License-Identifier: MIT */
/* depth_view の単体テスト。入力と期待値の対応は tests/CASES.md、段階の境界と 4x4 の期待文字列の検算は
   tools/verification/verify_depth_view_expected_values.py を参照 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "depth_view.h"
#include "unity.h"

#define ZONES_MAX (DEPTH_VIEW_MAX_SIDE * DEPTH_VIEW_MAX_SIDE)

/* テスト用のフレーム(配列は 8x8 ぶん確保し、4x4 では先頭 16 個を使う) */
static int16_t dist[ZONES_MAX];
static uint8_t status[ZONES_MAX];
static uint16_t sigma[ZONES_MAX];
static uint8_t ntar[ZONES_MAX];
static depth_view_frame_t frame;

/* 描画先。末尾の検査用に余分を持つ */
#define CANARY_BYTES 16u
static char buf[DEPTH_VIEW_RENDER_BUF_SIZE + CANARY_BYTES];

/* 全ゾーンを「ステータス 5、ターゲット 1、sigma 10、距離 1000 mm」にする */
static void frame_init(uint32_t side) {
  for (uint32_t i = 0; i < ZONES_MAX; i++) {
    dist[i] = 1000;
    status[i] = 5;
    sigma[i] = 10;
    ntar[i] = 1;
  }
  frame = (depth_view_frame_t){side, dist, status, sigma, ntar};
}

static depth_view_options_t opts(bool color, bool flip_h, bool flip_v) {
  return (depth_view_options_t){flip_h, flip_v, color, 50, 2000};
}

void setUp(void) {
  frame_init(8);
}

void tearDown(void) {}

/* ---- depth_view_classify ---- */

static void test_classify_valid_status_5_and_9(void) {
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_VALID, depth_view_classify(5, 1, 10, 50));
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_VALID, depth_view_classify(9, 1, 10, 50));
}

static void test_classify_sigma_boundary(void) {
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_VALID, depth_view_classify(5, 1, 50, 50));
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_SIGMA_OVER, depth_view_classify(5, 1, 51, 50));
}

static void test_classify_no_target(void) {
  /* ターゲット数 0 はステータスによらずターゲットなし。ステータス 255 もターゲットなし */
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_NO_TARGET, depth_view_classify(5, 0, 10, 50));
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_NO_TARGET, depth_view_classify(255, 1, 10, 50));
}

static void test_classify_bad_status_before_sigma(void) {
  /* 起動直後の 1 フレーム目に出るステータス 6 / 13。sigma 超過よりステータス無効を優先する */
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_BAD_STATUS, depth_view_classify(6, 1, 10, 50));
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_BAD_STATUS, depth_view_classify(13, 1, 10, 50));
  TEST_ASSERT_EQUAL(DEPTH_VIEW_ZONE_BAD_STATUS, depth_view_classify(6, 1, 999, 50));
}

/* ---- depth_view_zone_at ---- */

static void test_zone_at_no_flip(void) {
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_zone_at(8, 0, 0, false, false));
  TEST_ASSERT_EQUAL_UINT32(7, depth_view_zone_at(8, 0, 7, false, false));
  TEST_ASSERT_EQUAL_UINT32(56, depth_view_zone_at(8, 7, 0, false, false));
  TEST_ASSERT_EQUAL_UINT32(19, depth_view_zone_at(8, 2, 3, false, false));
}

static void test_zone_at_flips(void) {
  TEST_ASSERT_EQUAL_UINT32(7, depth_view_zone_at(8, 0, 0, true, false));
  TEST_ASSERT_EQUAL_UINT32(56, depth_view_zone_at(8, 0, 0, false, true));
  TEST_ASSERT_EQUAL_UINT32(63, depth_view_zone_at(8, 0, 0, true, true));
  /* (2, 3): 左右反転で列 4、上下反転で行 5 */
  TEST_ASSERT_EQUAL_UINT32(20, depth_view_zone_at(8, 2, 3, true, false));
  TEST_ASSERT_EQUAL_UINT32(43, depth_view_zone_at(8, 2, 3, false, true));
  TEST_ASSERT_EQUAL_UINT32(44, depth_view_zone_at(8, 2, 3, true, true));
  /* 4x4: (1, 2) の両反転は (2, 1) */
  TEST_ASSERT_EQUAL_UINT32(9, depth_view_zone_at(4, 1, 2, true, true));
}

static void test_zone_at_is_bijection(void) {
  /* どの反転の組み合わせでも、表示の全位置にすべてのゾーンがちょうど 1 回ずつ出る */
  for (uint32_t side = 1; side <= DEPTH_VIEW_MAX_SIDE; side++) {
    for (uint32_t f = 0; f < 4u; f++) {
      uint32_t seen[ZONES_MAX] = {0};
      for (uint32_t r = 0; r < side; r++) {
        for (uint32_t c = 0; c < side; c++) {
          const uint32_t z = depth_view_zone_at(side, r, c, (f & 1u) != 0u, (f & 2u) != 0u);
          TEST_ASSERT_TRUE(z < side * side);
          seen[z]++;
        }
      }
      for (uint32_t z = 0; z < side * side; z++) TEST_ASSERT_EQUAL_UINT32(1, seen[z]);
    }
  }
}

static void test_zone0_corner_matches_zone_at(void) {
  /* 文字列が depth_view_zone_at でゾーン 0 が来る位置と一致する */
  TEST_ASSERT_EQUAL_STRING("top-left", depth_view_zone0_corner(false, false));
  TEST_ASSERT_EQUAL_STRING("top-right", depth_view_zone0_corner(true, false));
  TEST_ASSERT_EQUAL_STRING("bottom-left", depth_view_zone0_corner(false, true));
  TEST_ASSERT_EQUAL_STRING("bottom-right", depth_view_zone0_corner(true, true));
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_zone_at(8, 0, 7, true, false));
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_zone_at(8, 7, 0, false, true));
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_zone_at(8, 7, 7, true, true));
}

/* ---- depth_view_level(期待値は verify_depth_view_expected_values.py で検算) ---- */

static void test_level_boundaries_2000(void) {
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_level(0, 2000));
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_level(250, 2000));
  TEST_ASSERT_EQUAL_UINT32(1, depth_view_level(251, 2000));
  TEST_ASSERT_EQUAL_UINT32(6, depth_view_level(1750, 2000));
  TEST_ASSERT_EQUAL_UINT32(7, depth_view_level(1751, 2000));
  TEST_ASSERT_EQUAL_UINT32(7, depth_view_level(2000, 2000));
}

static void test_level_out_of_range_and_negative(void) {
  TEST_ASSERT_EQUAL_UINT32(DEPTH_VIEW_LEVELS, depth_view_level(2001, 2000));
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_level(-5, 2000));
}

static void test_level_extreme_ranges(void) {
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_level(0, 0));
  TEST_ASSERT_EQUAL_UINT32(DEPTH_VIEW_LEVELS, depth_view_level(1, 0));
  TEST_ASSERT_EQUAL_UINT32(3, depth_view_level(32767, 65535));
}

/* ---- depth_view_stats ---- */

static void test_stats_counts_and_sigma(void) {
  frame_init(4);
  /* ステータス有効な 4 ゾーン(sigma 30, 10, 20, 40)と、無効 3 種。残り 9 ゾーンはターゲットなし */
  for (uint32_t i = 0; i < 16; i++) ntar[i] = 0;
  const uint16_t s[4] = {30, 10, 20, 40};
  for (uint32_t i = 0; i < 4; i++) {
    ntar[i] = 1;
    sigma[i] = s[i];
  }
  ntar[4] = 1;
  status[4] = 6; /* ステータス無効 */
  ntar[5] = 1;
  sigma[5] = 60; /* sigma 超過(ステータス有効なので統計に入る) */

  depth_view_stats_t st;
  depth_view_stats(&frame, 50, &st);
  TEST_ASSERT_EQUAL_UINT32(4, st.count[DEPTH_VIEW_ZONE_VALID]);
  TEST_ASSERT_EQUAL_UINT32(1, st.count[DEPTH_VIEW_ZONE_BAD_STATUS]);
  TEST_ASSERT_EQUAL_UINT32(1, st.count[DEPTH_VIEW_ZONE_SIGMA_OVER]);
  TEST_ASSERT_EQUAL_UINT32(10, st.count[DEPTH_VIEW_ZONE_NO_TARGET]);
  TEST_ASSERT_EQUAL_UINT32(5, st.status_ok);
  /* 昇順 10 20 30 40 60 → 最大 60、中央値 30 */
  TEST_ASSERT_EQUAL_UINT16(60, st.sigma_max);
  TEST_ASSERT_EQUAL_UINT16(30, st.sigma_median);
}

static void test_stats_even_count_lower_median(void) {
  frame_init(4);
  for (uint32_t i = 0; i < 16; i++) ntar[i] = 0;
  const uint16_t s[4] = {30, 10, 20, 40};
  for (uint32_t i = 0; i < 4; i++) {
    ntar[i] = 1;
    sigma[i] = s[i];
  }
  depth_view_stats_t st;
  depth_view_stats(&frame, 50, &st);
  TEST_ASSERT_EQUAL_UINT32(4, st.status_ok);
  TEST_ASSERT_EQUAL_UINT16(40, st.sigma_max);
  TEST_ASSERT_EQUAL_UINT16(20, st.sigma_median);
}

static void test_stats_no_status_ok(void) {
  for (uint32_t i = 0; i < ZONES_MAX; i++) status[i] = 6;
  depth_view_stats_t st;
  depth_view_stats(&frame, 50, &st);
  TEST_ASSERT_EQUAL_UINT32(64, st.count[DEPTH_VIEW_ZONE_BAD_STATUS]);
  TEST_ASSERT_EQUAL_UINT32(0, st.status_ok);
  TEST_ASSERT_EQUAL_UINT16(0, st.sigma_max);
  TEST_ASSERT_EQUAL_UINT16(0, st.sigma_median);
}

/* ---- depth_view_render ---- */

/* 4x4: zone i の距離 = i * 100 mm。zone 5 = ステータス無効、6 = sigma 超過、7 = ターゲットなし */
static void make_4x4_pattern(void) {
  frame_init(4);
  for (uint32_t i = 0; i < 16; i++) dist[i] = (int16_t)(i * 100u);
  status[5] = 6;
  sigma[6] = 60;
  ntar[7] = 0;
}

static void test_render_mono_4x4_exact(void) {
  make_4x4_pattern();
  const depth_view_options_t o = opts(false, false, false);
  const char *expected = "                 up\n"
                         "       +--------------------+\n"
                         "       | @  0 @ 10 @ 20 % 30|\n"
                         "  9pin | % 40 x    ?        | 4pin\n"
                         "       | * 80 * 90 *100 +110|\n"
                         "       | +120 =130 =140 =150|\n"
                         "       +--------------------+\n"
                         "                 down\n"
                         "[cm] near @%#*+=-: far .=>2000mm x=status ?=sigma>50mm blank=none\n";
  const size_t n = depth_view_render(buf, sizeof buf, &frame, &o);
  TEST_ASSERT_EQUAL_STRING(expected, buf);
  TEST_ASSERT_EQUAL_size_t(strlen(expected), n);
}

static void test_render_mono_4x4_flipped_rows(void) {
  make_4x4_pattern();
  const depth_view_options_t o = opts(false, true, true);
  depth_view_render(buf, sizeof buf, &frame, &o);
  /* 両反転: 表示の 1 行目はゾーン 15, 14, 13, 12、2 行目(目印の行)は 11, 10, 9, 8 */
  TEST_ASSERT_NOT_NULL(strstr(buf, "       | =150 =140 =130 +120|\n"));
  TEST_ASSERT_NOT_NULL(strstr(buf, "  9pin | +110 *100 * 90 * 80| 4pin\n"));
}

static void test_render_mono_has_no_escape(void) {
  make_4x4_pattern();
  const depth_view_options_t o = opts(false, false, false);
  depth_view_render(buf, sizeof buf, &frame, &o);
  TEST_ASSERT_NULL(strchr(buf, '\x1b'));
}

static void test_render_color_cells(void) {
  make_4x4_pattern();
  const depth_view_options_t o = opts(true, false, false);
  const size_t n = depth_view_render(buf, sizeof buf, &frame, &o);
  TEST_ASSERT_EQUAL_size_t(strlen(buf), n);
  /* 先頭でカーソルを左上へ */
  TEST_ASSERT_EQUAL_INT(0, strncmp(buf, "\x1b[H", 3));
  /* zone 0(段階 0、赤、黒文字)と zone 5(無効、灰色)、zone 15(1500 mm = 段階 5) */
  TEST_ASSERT_NOT_NULL(strstr(buf, "\x1b[48;5;196;38;5;16m   0"));
  TEST_ASSERT_NOT_NULL(strstr(buf, "\x1b[48;5;240;38;5;231m  x "));
  TEST_ASSERT_NOT_NULL(strstr(buf, "\x1b[48;5;46;38;5;16m 150"));
  /* 各行の末尾は行の残りの消去 + 改行 */
  TEST_ASSERT_NOT_NULL(strstr(buf, "\x1b[0m| 4pin\x1b[K\n"));
}

static void test_render_color_out_of_range(void) {
  make_4x4_pattern();
  dist[0] = 2500;
  const depth_view_options_t o = opts(true, false, false);
  depth_view_render(buf, sizeof buf, &frame, &o);
  TEST_ASSERT_NOT_NULL(strstr(buf, "\x1b[48;5;53;38;5;231m 250"));
}

static void test_render_mono_cm_clamp_and_negative(void) {
  make_4x4_pattern();
  dist[0] = 12000; /* 1200 cm → 999 で頭打ち、範囲外の '.' */
  dist[1] = -20;   /* 負 → 0 cm、段階 0 */
  const depth_view_options_t o = opts(false, false, false);
  depth_view_render(buf, sizeof buf, &frame, &o);
  TEST_ASSERT_NOT_NULL(strstr(buf, "       | .999 @  0 @ 20 % 30|\n"));
}

/* 見た目の桁数(ESC [ ... の英字で終わる ANSI エスケープと改行を除く)が DEPTH_VIEW_COLS_MAX 以下で、
   ESC 以外は印字可能な ASCII(0x20〜0x7E)だけであることを、各行について検査する */
static void check_visible_width(const char *s) {
  uint32_t cols = 0;
  for (const char *p = s; *p != '\0'; p++) {
    if (*p == '\x1b') {
      TEST_ASSERT_EQUAL_CHAR('[', p[1]);
      p += 2;
      while (!((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z'))) {
        TEST_ASSERT_NOT_EQUAL('\0', *p);
        p++;
      }
      continue;
    }
    if (*p == '\n') {
      TEST_ASSERT_TRUE(cols <= DEPTH_VIEW_COLS_MAX);
      cols = 0;
      continue;
    }
    TEST_ASSERT_TRUE(*p >= 0x20 && *p <= 0x7E);
    cols++;
  }
  TEST_ASSERT_EQUAL_UINT32(0, cols); /* 最後は改行で終わる */
}

/* 生成した文字列の各行(改行を含む)が DEPTH_VIEW_LINE_MAX 以下で、行数が上限以下かを検査する */
static void check_lines(const char *s, size_t n) {
  TEST_ASSERT_TRUE(n < DEPTH_VIEW_RENDER_BUF_SIZE);
  uint32_t lines = 0;
  size_t start = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '\n') {
      TEST_ASSERT_TRUE(i + 1u - start <= DEPTH_VIEW_LINE_MAX);
      start = i + 1u;
      lines++;
    }
  }
  TEST_ASSERT_EQUAL_size_t(n, start); /* 最後は改行で終わる */
  TEST_ASSERT_TRUE(lines <= DEPTH_VIEW_MAX_LINES);
}

static void test_render_worst_case_fits(void) {
  /* 最長になるのは 8x8 カラーで全ゾーン無効(色指定が 20 バイト)。範囲外(背景 17)や段階 0〜6 も含めて確かめる */
  const depth_view_options_t o = opts(true, false, false);
  for (uint32_t i = 0; i < ZONES_MAX; i++) status[i] = 6;
  size_t n = depth_view_render(buf, sizeof buf, &frame, &o);
  TEST_ASSERT_TRUE(n > 0u);
  check_lines(buf, n);
  frame_init(8);
  for (uint32_t i = 0; i < ZONES_MAX; i++) dist[i] = 30000;
  n = depth_view_render(buf, sizeof buf, &frame, &o);
  TEST_ASSERT_TRUE(n > 0u);
  check_lines(buf, n);
}

/* 固定シードの線形合同法(テストの再現性のため) */
static uint32_t rng_state = 12345u;
static uint32_t rng(void) {
  rng_state = rng_state * 1103515245u + 12345u;
  return rng_state >> 8;
}

static void test_render_random_frames_fit(void) {
  /* 乱数のフレームを、辺 1〜8・表示の設定 8 通りで描画し、長さの上限とバッファの外を書かないことを検査する */
  for (uint32_t iter = 0; iter < 400u; iter++) {
    frame_init(1u + iter % DEPTH_VIEW_MAX_SIDE);
    for (uint32_t i = 0; i < ZONES_MAX; i++) {
      /* -1000〜32767 mm(int16_t で表せる範囲だけを作る) */
      dist[i] = (int16_t)((int32_t)(rng() % 33768u) - 1000);
      const uint8_t st[6] = {5, 9, 6, 13, 255, (uint8_t)rng()};
      status[i] = st[rng() % 6u];
      sigma[i] = (uint16_t)(rng() % 200u);
      ntar[i] = (uint8_t)(rng() % 3u);
    }
    const uint32_t f = iter % 8u;
    depth_view_options_t o = opts((f & 1u) != 0u, (f & 2u) != 0u, (f & 4u) != 0u);
    o.sigma_max_mm = (uint16_t)(rng() % 100u);
    o.range_max_mm = (uint16_t)(rng() % 5000u);
    memset(buf, 0x5A, sizeof buf);
    const size_t n = depth_view_render(buf, DEPTH_VIEW_RENDER_BUF_SIZE, &frame, &o);
    TEST_ASSERT_TRUE(n > 0u);
    TEST_ASSERT_EQUAL_size_t(strlen(buf), n);
    check_lines(buf, n);
    for (uint32_t k = 0; k < CANARY_BYTES; k++)
      TEST_ASSERT_EQUAL_HEX8(0x5A, (uint8_t)buf[DEPTH_VIEW_RENDER_BUF_SIZE + k]);
  }
}

static void test_render_fits_80_columns(void) {
  /* 8x8 で凡例が最も長くなる設定(上限を 5 桁)。カラー・モノクロとも、全ゾーン無効 / 範囲外 / 有効で検査する */
  for (uint32_t color = 0; color < 2u; color++) {
    depth_view_options_t o = opts(color != 0u, true, true);
    o.sigma_max_mm = 65535u;
    o.range_max_mm = 65535u;
    for (uint32_t pattern = 0; pattern < 3u; pattern++) {
      frame_init(8);
      for (uint32_t i = 0; i < ZONES_MAX; i++) {
        if (pattern == 0u) status[i] = 6;
        if (pattern == 1u) dist[i] = 32767;
      }
      if (pattern == 1u) o.range_max_mm = 100u;
      TEST_ASSERT_TRUE(depth_view_render(buf, sizeof buf, &frame, &o) > 0u);
      check_visible_width(buf);
    }
  }
}

static void test_render_rejects_small_buffer(void) {
  const depth_view_options_t o = opts(true, false, false);
  memset(buf, 0x5A, sizeof buf);
  TEST_ASSERT_EQUAL_size_t(0, depth_view_render(buf, DEPTH_VIEW_RENDER_BUF_SIZE - 1u, &frame, &o));
  TEST_ASSERT_EQUAL_HEX8(0, (uint8_t)buf[0]);
  for (size_t k = 1; k < sizeof buf; k++) TEST_ASSERT_EQUAL_HEX8(0x5A, (uint8_t)buf[k]);

  memset(buf, 0x5A, sizeof buf);
  TEST_ASSERT_EQUAL_size_t(0, depth_view_render(buf, 0, &frame, &o));
  TEST_ASSERT_EQUAL_HEX8(0x5A, (uint8_t)buf[0]);
}

static void test_render_rejects_bad_side(void) {
  const depth_view_options_t o = opts(false, false, false);
  frame.side = 0;
  TEST_ASSERT_EQUAL_size_t(0, depth_view_render(buf, sizeof buf, &frame, &o));
  TEST_ASSERT_EQUAL_STRING("", buf);
  frame.side = DEPTH_VIEW_MAX_SIDE + 1u;
  TEST_ASSERT_EQUAL_size_t(0, depth_view_render(buf, sizeof buf, &frame, &o));
  TEST_ASSERT_EQUAL_STRING("", buf);
}

/* ---- depth_view_render_status ---- */

static void test_status_typical_exact(void) {
  frame_init(8);
  depth_view_status_t st = {0};
  st.frame_no = 123;
  st.warming_up = false;
  st.temp_c = 31;
  st.fps_x10 = 150;
  st.read_us = 11205;
  st.draw_us = 3400;
  st.bytes_per_frame = 452;
  st.ready_errors = 0;
  st.data_errors = 2;
  st.zones = 64;
  st.stats = (depth_view_stats_t){{61, 1, 1, 1}, 62, 80, 18};
  const depth_view_options_t o = opts(false, true, false);
  static char sbuf[DEPTH_VIEW_STATUS_BUF_SIZE];
  const size_t n = depth_view_render_status(sbuf, sizeof sbuf, &st, &o);
  const char *expected = "frame 123 | temp 31C | zone0 top-right (h=1 v=0)\n"
                         "15.0 fps | read 11.20 ms | draw 3 ms | 452 B/frame\n"
                         "valid 61/64 (x 1, ? 1, none 1) | errors ready 0 data 2\n"
                         "sigma of status-ok zones: median 18 max 80 limit 50 | keys h v c ?\n";
  TEST_ASSERT_EQUAL_STRING(expected, sbuf);
  TEST_ASSERT_EQUAL_size_t(strlen(expected), n);
}

static void test_status_read_ms_leading_zero_and_negative_temp(void) {
  depth_view_status_t st = {0};
  st.frame_no = 1;
  st.warming_up = true;
  st.temp_c = -5;
  st.read_us = 10050; /* 10.05 ms */
  st.zones = 64;
  const depth_view_options_t o = opts(true, false, true);
  static char sbuf[DEPTH_VIEW_STATUS_BUF_SIZE];
  depth_view_render_status(sbuf, sizeof sbuf, &st, &o);
  TEST_ASSERT_NOT_NULL(strstr(sbuf, "frame 1 (warming up) | temp -5C | zone0 bottom-left (h=0 v=1)\x1b[K\n"));
  TEST_ASSERT_NOT_NULL(strstr(sbuf, "0.0 fps | read 10.05 ms | draw 0 ms | 0 B/frame\x1b[K\n"));
}

static void test_status_worst_case_fits_80_columns(void) {
  /* 各値を表示が最も長くなる値にする(分類ごとの数とゾーン数は 64 が上限) */
  depth_view_status_t st;
  st.frame_no = UINT32_MAX;
  st.warming_up = true;
  st.temp_c = INT8_MIN;
  st.fps_x10 = UINT32_MAX; /* DEPTH_VIEW_FPS_X10_MAX で頭打ち */
  st.read_us = UINT32_MAX;
  st.draw_us = UINT32_MAX;
  st.bytes_per_frame = UINT32_MAX;
  st.ready_errors = UINT32_MAX;
  st.data_errors = UINT32_MAX;
  st.zones = 64;
  st.stats = (depth_view_stats_t){{64, 64, 64, 64}, 64, UINT16_MAX, UINT16_MAX};
  static char sbuf[DEPTH_VIEW_STATUS_BUF_SIZE + CANARY_BYTES];
  for (uint32_t f = 0; f < 8u; f++) {
    depth_view_options_t o = opts((f & 1u) != 0u, (f & 2u) != 0u, (f & 4u) != 0u);
    o.sigma_max_mm = UINT16_MAX;
    memset(sbuf, 0x5A, sizeof sbuf);
    const size_t n = depth_view_render_status(sbuf, DEPTH_VIEW_STATUS_BUF_SIZE, &st, &o);
    TEST_ASSERT_TRUE(n > 0u);
    TEST_ASSERT_EQUAL_size_t(strlen(sbuf), n);
    check_visible_width(sbuf);
    for (uint32_t k = 0; k < CANARY_BYTES; k++) {
      TEST_ASSERT_EQUAL_HEX8(0x5A, (uint8_t)sbuf[DEPTH_VIEW_STATUS_BUF_SIZE + k]);
    }
  }
  /* bottom-right と両反転、fps の頭打ちが出ていること */
  const depth_view_options_t o = opts(true, true, true);
  depth_view_render_status(sbuf, DEPTH_VIEW_STATUS_BUF_SIZE, &st, &o);
  TEST_ASSERT_NOT_NULL(strstr(sbuf, "zone0 bottom-right (h=1 v=1)"));
  TEST_ASSERT_NOT_NULL(strstr(sbuf, "9999.9 fps"));
}

static void test_status_rejects_small_buffer(void) {
  depth_view_status_t st = {0};
  const depth_view_options_t o = opts(false, false, false);
  static char sbuf[DEPTH_VIEW_STATUS_BUF_SIZE];
  memset(sbuf, 0x5A, sizeof sbuf);
  TEST_ASSERT_EQUAL_size_t(0, depth_view_render_status(sbuf, DEPTH_VIEW_STATUS_BUF_SIZE - 1u, &st, &o));
  TEST_ASSERT_EQUAL_HEX8(0, (uint8_t)sbuf[0]);
  TEST_ASSERT_EQUAL_HEX8(0x5A, (uint8_t)sbuf[1]);
}

/* ---- depth_view_help_text / depth_view_fps_x10 ---- */

static void test_help_fits_80_columns(void) {
  check_visible_width(depth_view_help_text());
  TEST_ASSERT_NULL(strchr(depth_view_help_text(), '\x1b'));
}

static void test_fps_x10(void) {
  /* 15 フレームで 1 秒 → 15.0 fps、14 間隔で 933333 µs → 15.0 fps */
  TEST_ASSERT_EQUAL_UINT32(150, depth_view_fps_x10(15, 1000000u));
  TEST_ASSERT_EQUAL_UINT32(150, depth_view_fps_x10(14, 933333u));
  TEST_ASSERT_EQUAL_UINT32(149, depth_view_fps_x10(14, 933334u));
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_fps_x10(0, 1000u));
  TEST_ASSERT_EQUAL_UINT32(0, depth_view_fps_x10(15, 0));
  TEST_ASSERT_EQUAL_UINT32(DEPTH_VIEW_FPS_X10_MAX, depth_view_fps_x10(15, 1u));
  TEST_ASSERT_EQUAL_UINT32(DEPTH_VIEW_FPS_X10_MAX, depth_view_fps_x10(UINT32_MAX, 1u));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_classify_valid_status_5_and_9);
  RUN_TEST(test_classify_sigma_boundary);
  RUN_TEST(test_classify_no_target);
  RUN_TEST(test_classify_bad_status_before_sigma);
  RUN_TEST(test_zone_at_no_flip);
  RUN_TEST(test_zone_at_flips);
  RUN_TEST(test_zone_at_is_bijection);
  RUN_TEST(test_zone0_corner_matches_zone_at);
  RUN_TEST(test_level_boundaries_2000);
  RUN_TEST(test_level_out_of_range_and_negative);
  RUN_TEST(test_level_extreme_ranges);
  RUN_TEST(test_stats_counts_and_sigma);
  RUN_TEST(test_stats_even_count_lower_median);
  RUN_TEST(test_stats_no_status_ok);
  RUN_TEST(test_render_mono_4x4_exact);
  RUN_TEST(test_render_mono_4x4_flipped_rows);
  RUN_TEST(test_render_mono_has_no_escape);
  RUN_TEST(test_render_color_cells);
  RUN_TEST(test_render_color_out_of_range);
  RUN_TEST(test_render_mono_cm_clamp_and_negative);
  RUN_TEST(test_render_worst_case_fits);
  RUN_TEST(test_render_random_frames_fit);
  RUN_TEST(test_render_fits_80_columns);
  RUN_TEST(test_render_rejects_small_buffer);
  RUN_TEST(test_render_rejects_bad_side);
  RUN_TEST(test_status_typical_exact);
  RUN_TEST(test_status_read_ms_leading_zero_and_negative_temp);
  RUN_TEST(test_status_worst_case_fits_80_columns);
  RUN_TEST(test_status_rejects_small_buffer);
  RUN_TEST(test_help_fits_80_columns);
  RUN_TEST(test_fps_x10);
  return UNITY_END();
}
