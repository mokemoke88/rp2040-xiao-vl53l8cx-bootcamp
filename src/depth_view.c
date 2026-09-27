/* SPDX-License-Identifier: MIT */
#include "depth_view.h"

#include "uld_util.h"

/** @brief ULD がターゲットのないゾーンに入れる測距ステータス。 */
#define STATUS_NO_TARGET 255u

/** @brief カラー表示の 1 ゾーンの幅(文字数)。距離 [cm] を右詰め 4 桁。ゾーンの境目は背景色で分かる。 */
#define CELL_WIDTH_COLOR 4u

/** @brief モノクロ表示の 1 ゾーンの幅(文字数)。区切りの空白 + 濃淡の文字 + 距離 [cm] 3 桁。 */
#define CELL_WIDTH_MONO 5u

/** @brief 表示する距離 [cm] の上限(3 桁)。 */
#define CM_MAX 999u

/**
 * @brief モノクロ表示の濃淡の文字。添字が段階(0 が最も近い = 最も濃い)。
 *
 * 最後の '.' は範囲外(range_max_mm 超)。ターゲットなしのゾーンは空白にするので、ここには空白を入れない。
 */
static const char MONO_RAMP[DEPTH_VIEW_LEVELS + 1u] = {'@', '%', '#', '*', '+', '=', '-', ':', '.'};

/**
 * @brief カラー表示の背景色(ANSI 256 色の番号)。添字が段階。近 = 赤 → 黄 → 緑 → 遠 = 青、最後は範囲外(暗い紫 53)。
 *
 * 範囲外は、段階 7 の青(21)と見分けやすく、無効に使う灰色(240)とも違う色にしている。
 */
static const uint8_t COLOR_BG[DEPTH_VIEW_LEVELS + 1u] = {196, 202, 208, 220, 190, 46, 39, 21, 53};

/** @brief カラー表示の文字色(ANSI 256 色の番号)。背景が暗い段階だけ白、ほかは黒。 */
static const uint8_t COLOR_FG[DEPTH_VIEW_LEVELS + 1u] = {16, 16, 16, 16, 16, 16, 16, 231, 231};

/** @brief カラー表示で無効なゾーンの背景色(灰色)と文字色(白)。 */
#define COLOR_INVALID_BG 240u
/** @brief カラー表示で無効なゾーンの文字色(白)。 */
#define COLOR_INVALID_FG 231u

/** @brief 左の目印の欄(8 文字)。目印を出す行以外は空白 + 枠。 */
#define LEFT_LABEL "  9pin |"
/** @brief 左の目印を出さない行の欄(8 文字)。 */
#define LEFT_BLANK "       |"
/** @brief 右の目印。 */
#define RIGHT_LABEL "| 4pin"

/** @brief 組み立て中の出力。容量を超える書き込みは捨てて overflow を立てる(buf を越えて書かない)。 */
typedef struct {
  /** @brief 出力先。 */
  char *p;
  /** @brief 出力先のバイト数(終端の NUL を含む)。 */
  size_t cap;
  /** @brief 書いた文字数(NUL を含まない)。 */
  size_t len;
  /** @brief 容量を超えて捨てた書き込みがあれば true。 */
  bool overflow;
} out_t;

/**
 * @brief 1 文字追加する。終端の NUL の分を残して容量を超える場合は捨てる。
 * @param o 出力
 * @param c 文字
 */
static void put_char(out_t *o, char c) {
  if (o->len + 1u < o->cap) {
    o->p[o->len++] = c;
  } else {
    o->overflow = true;
  }
}

/**
 * @brief 文字列を追加する。
 * @param o 出力
 * @param s NUL 終端の文字列
 */
static void put_str(out_t *o, const char *s) {
  while (*s != '\0') put_char(o, *s++);
}

/**
 * @brief 同じ文字を n 個追加する。
 * @param o 出力
 * @param c 文字
 * @param n 個数
 */
static void put_repeat(out_t *o, char c, uint32_t n) {
  for (uint32_t i = 0; i < n; i++) put_char(o, c);
}

/**
 * @brief 符号なし整数を 10 進で、width 桁に右詰め(左を空白で埋める)で追加する。width より長い場合はそのまま全桁出す。
 * @param o 出力
 * @param v 値
 * @param width 最小の桁数
 */
static void put_uint(out_t *o, uint32_t v, uint32_t width) {
  char digits[10];
  uint32_t n = 0;
  do {
    digits[n++] = (char)('0' + v % 10u);
    v /= 10u;
  } while (v != 0u);
  if (n < width) put_repeat(o, ' ', width - n);
  while (n > 0u) put_char(o, digits[--n]);
}

/**
 * @brief ANSI の色指定(背景色と文字色、256 色)を追加する。最長 20 バイト(ESC [ 48;5;NNN;38;5;NNN m)。
 * @param o 出力
 * @param bg 背景色
 * @param fg 文字色
 */
static void put_sgr(out_t *o, uint8_t bg, uint8_t fg) {
  put_str(o, "\x1b[48;5;");
  put_uint(o, bg, 0);
  put_str(o, ";38;5;");
  put_uint(o, fg, 0);
  put_char(o, 'm');
}

/**
 * @brief 距離 [mm] を表示用の [cm] にする(負は 0、CM_MAX で頭打ち、切り捨て)。
 * @param distance_mm 距離 [mm]
 * @return 距離 [cm]
 */
static uint32_t to_cm(int16_t distance_mm) {
  if (distance_mm < 0) return 0;
  const uint32_t cm = (uint32_t)distance_mm / 10u;
  return cm > CM_MAX ? CM_MAX : cm;
}

/**
 * @brief 符号付き整数を 10 進で追加する(左詰め)。
 * @param o 出力
 * @param v 値
 */
static void put_int(out_t *o, int32_t v) {
  if (v < 0) {
    put_char(o, '-');
    put_uint(o, (uint32_t)(-(int64_t)v), 0);
  } else {
    put_uint(o, (uint32_t)v, 0);
  }
}

/**
 * @brief 無効なゾーンの記号(ステータス無効 'x'、sigma 超過 '?'、ターゲットなし ' ')。
 * @param z 分類
 * @return 記号
 */
static char invalid_symbol(depth_view_zone_t z) {
  switch (z) {
  case DEPTH_VIEW_ZONE_BAD_STATUS:
    return 'x';
  case DEPTH_VIEW_ZONE_SIGMA_OVER:
    return '?';
  default:
    return ' ';
  }
}

/**
 * @brief 1 ゾーンを CELL_WIDTH 文字で追加する(カラーでは色指定を前に付ける)。
 * @param o 出力
 * @param frame 測距結果
 * @param zone ゾーン番号
 * @param opt 表示の設定
 */
static void put_cell(out_t *o, const depth_view_frame_t *frame, uint32_t zone, const depth_view_options_t *opt) {
  const depth_view_zone_t z = depth_view_classify(frame->target_status[zone], frame->nb_target_detected[zone],
                                                  frame->range_sigma_mm[zone], opt->sigma_max_mm);
  if (z != DEPTH_VIEW_ZONE_VALID) {
    if (opt->color) {
      /* カラー: 灰色の背景に記号 1 文字("  x ") */
      put_sgr(o, COLOR_INVALID_BG, COLOR_INVALID_FG);
      put_repeat(o, ' ', CELL_WIDTH_COLOR - 2u);
      put_char(o, invalid_symbol(z));
      put_char(o, ' ');
    } else {
      /* モノクロ: 濃淡の文字の位置に記号(" x   ") */
      put_char(o, ' ');
      put_char(o, invalid_symbol(z));
      put_repeat(o, ' ', CELL_WIDTH_MONO - 2u);
    }
    return;
  }
  const uint32_t level = depth_view_level(frame->distance_mm[zone], opt->range_max_mm);
  const uint32_t cm = to_cm(frame->distance_mm[zone]);
  if (opt->color) {
    /* カラー: 段階の背景色 + 距離 [cm] を右詰め */
    put_sgr(o, COLOR_BG[level], COLOR_FG[level]);
    put_uint(o, cm, CELL_WIDTH_COLOR);
  } else {
    /* モノクロ: 区切りの空白 + 濃淡の文字 1 つ + 距離 [cm] を 3 桁右詰め(" @ 45") */
    put_char(o, ' ');
    put_char(o, MONO_RAMP[level]);
    put_uint(o, cm, CELL_WIDTH_MONO - 2u);
  }
}

/**
 * @brief 行末を追加する(カラーでは色を戻し、行の残りを消してから改行)。
 * @param o 出力
 * @param color カラー表示か
 */
static void put_eol(out_t *o, bool color) {
  if (color) put_str(o, "\x1b[K");
  put_char(o, '\n');
}

/**
 * @brief 枠の上下の目印の行(「up」「down」を枠の中央付近に置く)を追加する。
 * @param o 出力
 * @param width 枠の内側の幅(文字数)
 * @param label 目印
 * @param color カラー表示か
 */
static void put_label_line(out_t *o, uint32_t width, const char *label, bool color) {
  put_repeat(o, ' ', 8u + width / 2u - 1u);
  put_str(o, label);
  put_eol(o, color);
}

/**
 * @brief 枠の上辺・下辺の行を追加する。
 * @param o 出力
 * @param width 枠の内側の幅(文字数)
 * @param color カラー表示か
 */
static void put_border(out_t *o, uint32_t width, bool color) {
  put_str(o, "       +");
  put_repeat(o, '-', width);
  put_char(o, '+');
  put_eol(o, color);
}

/**
 * @brief 凡例の行を追加する。
 * @param o 出力
 * @param opt 表示の設定
 */
static void put_legend(out_t *o, const depth_view_options_t *opt) {
  if (opt->color) {
    put_str(o, "[cm] red=near..blue=far purple=>");
  } else {
    put_str(o, "[cm] near @%#*+=-: far .=>");
  }
  put_uint(o, opt->range_max_mm, 0);
  put_str(o, "mm x=status ?=sigma>");
  put_uint(o, opt->sigma_max_mm, 0);
  put_str(o, "mm blank=none");
  put_eol(o, opt->color);
}

depth_view_zone_t depth_view_classify(uint8_t status, uint8_t nb_target, uint16_t sigma_mm, uint16_t sigma_max_mm) {
  if (nb_target == 0u || status == STATUS_NO_TARGET) return DEPTH_VIEW_ZONE_NO_TARGET;
  if (!uld_target_status_is_valid(status)) return DEPTH_VIEW_ZONE_BAD_STATUS;
  if (sigma_mm > sigma_max_mm) return DEPTH_VIEW_ZONE_SIGMA_OVER;
  return DEPTH_VIEW_ZONE_VALID;
}

uint32_t depth_view_zone_at(uint32_t side, uint32_t row, uint32_t col, bool flip_h, bool flip_v) {
  const uint32_t zr = flip_v ? side - 1u - row : row;
  const uint32_t zc = flip_h ? side - 1u - col : col;
  return zr * side + zc;
}

const char *depth_view_zone0_corner(bool flip_h, bool flip_v) {
  /* ゾーン 0 は反転なしで表示の (0, 0) = 左上。左右反転で右、上下反転で下へ移る */
  if (flip_v) return flip_h ? "bottom-right" : "bottom-left";
  return flip_h ? "top-right" : "top-left";
}

uint32_t depth_view_level(int16_t distance_mm, uint16_t range_max_mm) {
  const uint32_t d = distance_mm < 0 ? 0u : (uint32_t)distance_mm;
  if (d > range_max_mm) return DEPTH_VIEW_LEVELS;
  return d * DEPTH_VIEW_LEVELS / ((uint32_t)range_max_mm + 1u);
}

void depth_view_stats(const depth_view_frame_t *frame, uint16_t sigma_max_mm, depth_view_stats_t *out) {
  uint16_t sigmas[DEPTH_VIEW_MAX_SIDE * DEPTH_VIEW_MAX_SIDE];
  const uint32_t zones = frame->side * frame->side;

  *out = (depth_view_stats_t){{0, 0, 0, 0}, 0, 0, 0};
  for (uint32_t i = 0; i < zones && i < DEPTH_VIEW_MAX_SIDE * DEPTH_VIEW_MAX_SIDE; i++) {
    const depth_view_zone_t z = depth_view_classify(frame->target_status[i], frame->nb_target_detected[i],
                                                    frame->range_sigma_mm[i], sigma_max_mm);
    out->count[z]++;
    if (z == DEPTH_VIEW_ZONE_VALID || z == DEPTH_VIEW_ZONE_SIGMA_OVER) {
      /* 挿入ソートで昇順に並べながら集める(最大 64 個) */
      uint32_t j = out->status_ok++;
      while (j > 0u && sigmas[j - 1u] > frame->range_sigma_mm[i]) {
        sigmas[j] = sigmas[j - 1u];
        j--;
      }
      sigmas[j] = frame->range_sigma_mm[i];
    }
  }
  if (out->status_ok > 0u) {
    out->sigma_max = sigmas[out->status_ok - 1u];
    out->sigma_median = sigmas[(out->status_ok - 1u) / 2u];
  }
}

size_t depth_view_render(char *buf, size_t buf_size, const depth_view_frame_t *frame, const depth_view_options_t *opt) {
  if (buf_size > 0u) buf[0] = '\0';
  if (buf_size < DEPTH_VIEW_RENDER_BUF_SIZE || frame->side == 0u || frame->side > DEPTH_VIEW_MAX_SIDE) return 0;

  out_t o = {buf, buf_size, 0, false};
  const uint32_t side = frame->side;
  const uint32_t width = side * (opt->color ? CELL_WIDTH_COLOR : CELL_WIDTH_MONO);
  /* 左右の目印を出す行(上下の中央付近) */
  const uint32_t label_row = (side - 1u) / 2u;

  /* カラー表示はカーソルを左上へ戻して上書きする */
  if (opt->color) put_str(&o, "\x1b[H");

  put_label_line(&o, width, "up", opt->color);
  put_border(&o, width, opt->color);
  for (uint32_t row = 0; row < side; row++) {
    put_str(&o, row == label_row ? LEFT_LABEL : LEFT_BLANK);
    for (uint32_t col = 0; col < side; col++) {
      put_cell(&o, frame, depth_view_zone_at(side, row, col, opt->flip_h, opt->flip_v), opt);
    }
    if (opt->color) put_str(&o, "\x1b[0m");
    put_str(&o, row == label_row ? RIGHT_LABEL : "|");
    put_eol(&o, opt->color);
  }
  put_border(&o, width, opt->color);
  put_label_line(&o, width, "down", opt->color);
  put_legend(&o, opt);

  /* 容量は DEPTH_VIEW_RENDER_BUF_SIZE 以上を確かめてあるので overflow は起きない想定。起きたら出力を捨てる */
  if (o.overflow) {
    buf[0] = '\0';
    return 0;
  }
  buf[o.len] = '\0';
  return o.len;
}

/** @brief ヘルプの本文。各行 DEPTH_VIEW_COLS_MAX 桁以内(テストで検査する)。 */
static const char HELP_TEXT[] = "keys: h = flip left/right, v = flip up/down\n"
                                "      c = color/mono, ? = this help (upper case also works)\n"
                                "      b = binary output (for the browser), t = back to text\n"
                                "frame edges: hold the sensor facing you, 9pin row on your left.\n"
                                "  9pin / 4pin = carrier pin rows, up / down = as you hold it\n"
                                "zone0 (status line) = display corner where sensor zone 0 is drawn\n"
                                "cells: distance in cm\n"
                                "  x = bad target_status, ? = sigma over limit, blank = no target\n"
                                "(display resumes in a few seconds or on any key)\n";

const char *depth_view_help_text(void) {
  return HELP_TEXT;
}

uint32_t depth_view_fps_x10(uint32_t frames, uint64_t span_us) {
  if (frames == 0u || span_us == 0u) return 0;
  const uint64_t v = (uint64_t)frames * 10000000u / span_us;
  return v > DEPTH_VIEW_FPS_X10_MAX ? DEPTH_VIEW_FPS_X10_MAX : (uint32_t)v;
}

size_t depth_view_render_status(char *buf, size_t buf_size, const depth_view_status_t *st,
                                const depth_view_options_t *opt) {
  if (buf_size > 0u) buf[0] = '\0';
  if (buf_size < DEPTH_VIEW_STATUS_BUF_SIZE) return 0;

  out_t o = {buf, buf_size, 0, false};
  const uint32_t fps = st->fps_x10 > DEPTH_VIEW_FPS_X10_MAX ? DEPTH_VIEW_FPS_X10_MAX : st->fps_x10;

  /* 1 行目: フレーム番号、温度、ゾーン 0 の位置と反転(最長 73 桁) */
  put_str(&o, "frame ");
  put_uint(&o, st->frame_no, 0);
  if (st->warming_up) put_str(&o, " (warming up)");
  put_str(&o, " | temp ");
  put_int(&o, st->temp_c);
  put_str(&o, "C | zone0 ");
  put_str(&o, depth_view_zone0_corner(opt->flip_h, opt->flip_v));
  put_str(&o, opt->flip_h ? " (h=1" : " (h=0");
  put_str(&o, opt->flip_v ? " v=1)" : " v=0)");
  put_eol(&o, opt->color);

  /* 2 行目: フレームレート、読み出し・描画の時間、1 フレームのバイト数(最長 70 桁) */
  put_uint(&o, fps / 10u, 0);
  put_char(&o, '.');
  put_uint(&o, fps % 10u, 0);
  put_str(&o, " fps | read ");
  put_uint(&o, st->read_us / 1000u, 0);
  put_char(&o, '.');
  const uint32_t frac = st->read_us % 1000u / 10u;
  if (frac < 10u) put_char(&o, '0');
  put_uint(&o, frac, 0);
  put_str(&o, " ms | draw ");
  put_uint(&o, st->draw_us / 1000u, 0);
  put_str(&o, " ms | ");
  put_uint(&o, st->bytes_per_frame, 0);
  put_str(&o, " B/frame");
  put_eol(&o, opt->color);

  /* 3 行目: 有効なゾーン数と無効の内訳、読み出しエラーの累計(ゾーン数が 64 以下で最長 75 桁) */
  put_str(&o, "valid ");
  put_uint(&o, st->stats.count[DEPTH_VIEW_ZONE_VALID], 0);
  put_char(&o, '/');
  put_uint(&o, st->zones, 0);
  put_str(&o, " (x ");
  put_uint(&o, st->stats.count[DEPTH_VIEW_ZONE_BAD_STATUS], 0);
  put_str(&o, ", ? ");
  put_uint(&o, st->stats.count[DEPTH_VIEW_ZONE_SIGMA_OVER], 0);
  put_str(&o, ", none ");
  put_uint(&o, st->stats.count[DEPTH_VIEW_ZONE_NO_TARGET], 0);
  put_str(&o, ") | errors ready ");
  put_uint(&o, st->ready_errors, 0);
  put_str(&o, " data ");
  put_uint(&o, st->data_errors, 0);
  put_eol(&o, opt->color);

  /* 4 行目: ステータスが有効なゾーンの sigma の中央値・最大と上限、キー(最長 75 桁) */
  put_str(&o, "sigma of status-ok zones: median ");
  put_uint(&o, st->stats.sigma_median, 0);
  put_str(&o, " max ");
  put_uint(&o, st->stats.sigma_max, 0);
  put_str(&o, " limit ");
  put_uint(&o, opt->sigma_max_mm, 0);
  put_str(&o, " | keys h v c ?");
  put_eol(&o, opt->color);

  if (o.overflow) {
    buf[0] = '\0';
    return 0;
  }
  buf[o.len] = '\0';
  return o.len;
}
