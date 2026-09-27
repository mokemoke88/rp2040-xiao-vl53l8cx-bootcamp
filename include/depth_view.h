/* SPDX-License-Identifier: MIT */
/**
 * @file depth_view.h
 * @brief 測距結果(距離画像)をターミナル向けの文字列に組み立てる。ゾーンの有効判定、表示の向き、距離の段階化、
 *        sigma の統計も含む。
 *
 * stdint.h / stdbool.h / stddef.h だけに依存し、Pico SDK にも ULD の型にも依存しない。測距結果は ULD の
 * VL53L8CX_ResultsData の各配列(1 ゾーン 1 ターゲットの並び)をそのまま渡せる形で受け取る。
 * ホストの gcc で単体テストする(tests/test_depth_view.c)。
 *
 * 表示の向き: 表示の枠の外に、センサーを自分に向けて持ったときの物理的な向き(左 = 9 ピン列側、右 = 4 ピン列側、
 * 上 / 下)を固定で出す。どのゾーンがどの表示位置に来るかを反転フラグで変える。Pololu キャリア(#3419)をこの向きで
 * 持った場合に表示と一致する反転は、左右反転あり・上下反転なし(ゾーン 0 は表示の右上。2026-09-27、実機で確認)。
 *
 * 表示の各行は、ANSI エスケープを除いて DEPTH_VIEW_COLS_MAX 桁以内に収める(PuTTY の既定の 80 x 24 で折り返さない
 * ように)。テストで最長の場合を検査する。
 */
#ifndef DEPTH_VIEW_H
#define DEPTH_VIEW_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** @brief 一辺のゾーン数の最大(8x8)。 */
#define DEPTH_VIEW_MAX_SIDE 8u

/** @brief 距離の段階の数。段階 0 が最も近い。範囲外(range_max_mm 超)は段階 DEPTH_VIEW_LEVELS として扱う。 */
#define DEPTH_VIEW_LEVELS 8u

/**
 * @brief 描画する 1 行の最大バイト数(改行を含む)。
 *
 * 最も長いのは 8x8 のカラー表示のゾーンの行で、左の目印 8 + ゾーン 8 × 24(色指定 20 + 文字 4)+ 色の解除 4 +
 * 右の目印 6("| 4pin")+ 行末の消去 3 + 改行 1 = 214 バイト。余裕を見て 256 にし、テストで全行がこれ以下であることを
 * 検査する。
 */
#define DEPTH_VIEW_LINE_MAX 256u

/** @brief 表示の 1 行の見た目の桁数の上限(ANSI エスケープと改行を除く)。PuTTY の既定の端末幅。 */
#define DEPTH_VIEW_COLS_MAX 80u

/** @brief depth_view_render_status() が出す行数。 */
#define DEPTH_VIEW_STATUS_LINES 4u

/**
 * @brief depth_view_render_status() に渡すバッファに必要なバイト数(終端の NUL を含む)。
 *
 * 各行は見た目 DEPTH_VIEW_COLS_MAX 桁以内 + 行末の消去 3 + 改行 1。
 */
#define DEPTH_VIEW_STATUS_BUF_SIZE (DEPTH_VIEW_STATUS_LINES * (DEPTH_VIEW_COLS_MAX + 4u) + 1u)

/** @brief depth_view_fps_x10() が返す値の上限(9999.9 fps)。表示の桁数を抑えるため。 */
#define DEPTH_VIEW_FPS_X10_MAX 99999u

/** @brief 描画する行数の最大(上の目印、上の枠、ゾーンの行、下の枠、下の目印、凡例)。 */
#define DEPTH_VIEW_MAX_LINES (DEPTH_VIEW_MAX_SIDE + 5u)

/**
 * @brief depth_view_render() に渡すバッファに必要なバイト数(終端の NUL を含む)。
 *
 * 画面の左上へのカーソル移動(3 バイト)と、最大行数 × 1 行の最大バイト数の和に NUL の 1 を足したもの。
 */
#define DEPTH_VIEW_RENDER_BUF_SIZE (3u + DEPTH_VIEW_MAX_LINES * DEPTH_VIEW_LINE_MAX + 1u)

/** @brief ゾーンの分類。 */
typedef enum {
  /** @brief 有効(ステータスが 5 / 9 で、sigma がしきい値以下)。 */
  DEPTH_VIEW_ZONE_VALID = 0,
  /** @brief ターゲットなし(ターゲット数が 0、またはステータスが 255)。 */
  DEPTH_VIEW_ZONE_NO_TARGET,
  /** @brief ステータスが 5 / 9 以外。 */
  DEPTH_VIEW_ZONE_BAD_STATUS,
  /** @brief ステータスは有効だが、sigma がしきい値を超える。 */
  DEPTH_VIEW_ZONE_SIGMA_OVER,
} depth_view_zone_t;

/** @brief 1 フレームの測距結果。各配列はゾーン番号(zone = 行 × side + 列)で並ぶ。 */
typedef struct {
  /** @brief 一辺のゾーン数(4 または 8)。1〜DEPTH_VIEW_MAX_SIDE を受け付ける。 */
  uint32_t side;
  /** @brief 距離 [mm](ULD の distance_mm)。 */
  const int16_t *distance_mm;
  /** @brief 測距ステータス(ULD の target_status)。 */
  const uint8_t *target_status;
  /** @brief 距離の sigma [mm](ULD の range_sigma_mm)。 */
  const uint16_t *range_sigma_mm;
  /** @brief ターゲット数(ULD の nb_target_detected)。 */
  const uint8_t *nb_target_detected;
} depth_view_frame_t;

/** @brief 表示の設定。 */
typedef struct {
  /** @brief 左右反転。false なら表示の列 c にゾーンの列 c、true なら列 side - 1 - c を出す。 */
  bool flip_h;
  /** @brief 上下反転。false なら表示の行 r にゾーンの行 r、true なら行 side - 1 - r を出す。 */
  bool flip_v;
  /** @brief true なら ANSI 256 色のカラー表示、false なら文字の濃淡のモノクロ表示(ANSI エスケープなし)。 */
  bool color;
  /** @brief 有効とみなす sigma の上限 [mm](この値以下が有効)。 */
  uint16_t sigma_max_mm;
  /** @brief 段階化する距離の上限 [mm]。これを超える距離は範囲外として表示する。 */
  uint16_t range_max_mm;
} depth_view_options_t;

/** @brief 1 フレームの集計。sigma の値は、ステータスが有効なゾーン(VALID と SIGMA_OVER)から求める。 */
typedef struct {
  /** @brief 分類ごとのゾーン数。添字は depth_view_zone_t。 */
  uint32_t count[4];
  /** @brief ステータスが有効なゾーンの数(sigma の統計の母数)。 */
  uint32_t status_ok;
  /** @brief ステータスが有効なゾーンの sigma の最大 [mm]。status_ok が 0 なら 0。 */
  uint16_t sigma_max;
  /** @brief ステータスが有効なゾーンの sigma の中央値 [mm](偶数個なら小さい側)。status_ok が 0 なら 0。 */
  uint16_t sigma_median;
} depth_view_stats_t;

/** @brief ステータス行に出す値。 */
typedef struct {
  /** @brief フレーム番号。 */
  uint32_t frame_no;
  /** @brief 起動直後の無効なフレームなら true("(warming up)" を付ける)。 */
  bool warming_up;
  /** @brief センサーの温度 [℃]。 */
  int8_t temp_c;
  /** @brief フレームレート × 10(depth_view_fps_x10() の値)。 */
  uint32_t fps_x10;
  /** @brief vl53l8cx_get_ranging_data() の所要時間 [µs]。 */
  uint32_t read_us;
  /** @brief 前のフレームの描画の所要時間 [µs]。 */
  uint32_t draw_us;
  /** @brief 1 フレームで読むバイト数(ULD の data_read_size)。 */
  uint32_t bytes_per_frame;
  /** @brief vl53l8cx_check_data_ready() のエラーの累計。 */
  uint32_t ready_errors;
  /** @brief vl53l8cx_get_ranging_data() のエラーの累計。 */
  uint32_t data_errors;
  /** @brief フレームのゾーン数(side × side)。 */
  uint32_t zones;
  /** @brief depth_view_stats() の結果。 */
  depth_view_stats_t stats;
} depth_view_status_t;

/**
 * @brief 1 ゾーンを分類する。
 * @param status 測距ステータス
 * @param nb_target ターゲット数
 * @param sigma_mm sigma [mm]
 * @param sigma_max_mm 有効とみなす sigma の上限 [mm]
 * @return 分類(ターゲットなし → ステータス無効 → sigma 超過 の順に判定する)
 */
depth_view_zone_t depth_view_classify(uint8_t status, uint8_t nb_target, uint16_t sigma_mm, uint16_t sigma_max_mm);

/**
 * @brief 表示の位置 (row, col) に出すゾーンの番号を返す。
 * @param side 一辺のゾーン数
 * @param row 表示の行(0 が上)
 * @param col 表示の列(0 が左)
 * @param flip_h 左右反転
 * @param flip_v 上下反転
 * @return ゾーン番号(行 × side + 列)
 */
uint32_t depth_view_zone_at(uint32_t side, uint32_t row, uint32_t col, bool flip_h, bool flip_v);

/**
 * @brief ゾーン 0 が表示のどの角に来るかを返す(ステータス行の表示用)。
 * @param flip_h 左右反転
 * @param flip_v 上下反転
 * @return "top-left" / "top-right" / "bottom-left" / "bottom-right"
 */
const char *depth_view_zone0_corner(bool flip_h, bool flip_v);

/**
 * @brief 距離を段階に変換する。
 *
 * 0〜range_max_mm を DEPTH_VIEW_LEVELS 段階に等分し、段階 = 距離 × DEPTH_VIEW_LEVELS / (range_max_mm + 1)
 * (切り捨て)とする。負の距離は 0 mm として扱う。range_max_mm を超える距離は DEPTH_VIEW_LEVELS(範囲外)を返す。
 * @param distance_mm 距離 [mm]
 * @param range_max_mm 段階化する距離の上限 [mm]
 * @return 0〜DEPTH_VIEW_LEVELS - 1 の段階、または範囲外の DEPTH_VIEW_LEVELS
 */
uint32_t depth_view_level(int16_t distance_mm, uint16_t range_max_mm);

/**
 * @brief 1 フレームを集計する。
 * @param frame 測距結果
 * @param sigma_max_mm 有効とみなす sigma の上限 [mm]
 * @param out 集計結果の格納先
 */
void depth_view_stats(const depth_view_frame_t *frame, uint16_t sigma_max_mm, depth_view_stats_t *out);

/**
 * @brief 1 フレームをターミナル向けの文字列に組み立て、buf に書く(終端の NUL を含む)。
 *
 * 行末は "\n"。カラー表示では先頭でカーソルを画面の左上へ移し(ESC [ H)、各行の末尾で行の残りを消す(ESC [ K)ので、
 * 続けて呼ぶと前のフレームを上書きする。モノクロ表示は ANSI エスケープを含まない。
 * buf_size が DEPTH_VIEW_RENDER_BUF_SIZE 未満、または frame->side が範囲外なら、何も書かずに 0 を返す
 * (buf_size が 1 以上なら buf[0] に NUL だけ書く)。
 * @param buf 出力先
 * @param buf_size buf のバイト数
 * @param frame 測距結果
 * @param opt 表示の設定
 * @return 書いた文字数(終端の NUL を含まない)
 */
size_t depth_view_render(char *buf, size_t buf_size, const depth_view_frame_t *frame, const depth_view_options_t *opt);

/**
 * @brief ステータス行(DEPTH_VIEW_STATUS_LINES 行)を組み立て、buf に書く(終端の NUL を含む)。
 *
 * 各行は見た目 DEPTH_VIEW_COLS_MAX 桁以内。カラー表示では各行の末尾で行の残りを消す(ESC [ K)。
 * buf_size が DEPTH_VIEW_STATUS_BUF_SIZE 未満なら何も書かずに 0 を返す(buf_size が 1 以上なら buf[0] に NUL だけ書く)。
 * 分類ごとのゾーン数・ゾーン数の表示は、depth_view_stats() の結果(64 以下)を前提にした桁数で収まるようにしている。
 * @param buf 出力先
 * @param buf_size buf のバイト数
 * @param st 表示する値
 * @param opt 表示の設定(反転・カラー・sigma の上限を表示に使う)
 * @return 書いた文字数(終端の NUL を含まない)
 */
size_t depth_view_render_status(char *buf, size_t buf_size, const depth_view_status_t *st,
                                const depth_view_options_t *opt);

/**
 * @brief キー操作と表示の読み方の説明文(各行 DEPTH_VIEW_COLS_MAX 桁以内、改行区切り、ASCII のみ)を返す。
 * @return NUL 終端の文字列
 */
const char *depth_view_help_text(void);

/**
 * @brief frames フレームにかかった時間から、フレームレート × 10 を求める(小数 1 桁を整数で表す)。
 * @param frames フレーム数(間隔の数)
 * @param span_us その間の時間 [µs]
 * @return frames × 10^7 / span_us(切り捨て)。span_us が 0 または frames が 0 なら 0。DEPTH_VIEW_FPS_X10_MAX で頭打ち
 */
uint32_t depth_view_fps_x10(uint32_t frames, uint64_t span_us);

#endif // DEPTH_VIEW_H
