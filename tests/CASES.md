# テストケース対応表

ホストで単体テストする Pico SDK 非依存の部分の、各テストの入力と期待値。

- `tests/test_uld_util.c` → `src/uld_util.c`(プラットフォーム層の計算)。前半の各節
- `tests/test_depth_view.c` → `src/depth_view.c`(距離画像の表示)。「depth_view」の節

## ビルド構成

`make test` は次の 3 つを実行する。

| 実行ファイル | 構成 |
|---|---|
| `build-host/test_uld_util` | 既定(分割書き込みの塊 `ULD_WRITE_CHUNK_BYTES` = 256) |
| `build-host/test_uld_util_small` | `-DULD_WRITE_CHUNK_BYTES=7u`。0x8000 などの長さが塊の長さで割り切れない場合を通す |
| `build-host/test_depth_view` | depth_view のテスト(uld_util.c も一緒にリンクする。ステータスの判定を再利用しているため) |

- 塊の長さに関わる期待値は `CHUNK`(= `ULD_WRITE_CHUNK_BYTES`)から計算している。塊の数は ⌈size / CHUNK⌉
- タイムアウトの期待値は `ULD_I2C_TIMEOUT_BASE_US`(10000)と `ULD_I2C_TIMEOUT_PER_BYTE_US`(100)から計算している

## uld_swap_buffer

| テスト | 入力 | 期待値 |
|---|---|---|
| reverses_each_4_bytes | `[1 2 3 4 5 6 7 8]`, size 8 | `[4 3 2 1 8 7 6 5]` |
| twice_restores | 12 バイト、2 回呼ぶ | 元に戻る |
| size_zero_changes_nothing | `[1 2 3 4]`, size 0 | 変化なし |
| leaves_remainder_and_outside | `[1 2 3 4 5 6 7 8]`, size 6 | `[4 3 2 1 5 6 7 8]`(余りの 2 バイトと size の外は変えない) |
| big_endian_word_to_value | `[0C 0B 6C 9E]`, size 4 | 反転後のバイトをリトルエンディアンで組み立てると 0x0C0B6C9E(ULD のファームウェアのチェックサム比較と同じ使い方) |

## uld_chunk_len / uld_chunk_reg

| テスト | 入力 | 期待値 |
|---|---|---|
| chunk_len_zero_total | total 0, offset 0 | 0 |
| chunk_len_exact_chunk | total CHUNK: offset 0 / CHUNK | CHUNK / 0 |
| chunk_len_one_over | total CHUNK+1: offset 0 / CHUNK / CHUNK+1 | CHUNK / 1 / 0 |
| chunk_len_shorter_than_chunk | total 1, offset 0 | 1 |
| chunk_len_offset_past_total | total 10, offset 11 | 0 |
| chunk_reg_adds_offset | (0x2C34, 0) / (0x2C34, 972) / (0, 0x7FFF) | 0x2C34 / 0x3000 / 0x7FFF |
| chunk_reg_truncates_to_16_bits | (0xFFFF, 1) | 0x0000 |

## uld_pack_write

| テスト | 入力 | 期待値 |
|---|---|---|
| address_big_endian | reg 0x2E18, data `[11 22 33]` | 戻り値 5、`[2E 18 11 22 33]`、6 バイト目は変えない |
| no_data | reg 0x812F, data NULL, len 0 | 戻り値 2、`[81 2F]`、3 バイト目は変えない |

## 分割書き込み(uld_write_chunked、wrmulti_*)

`src/platform.c` の `VL53L8CX_WrMulti` が呼ぶ `uld_write_chunked` に、1 塊を送る関数として模擬センサー(`fake_send`)を渡す。模擬センサーは「塊の先頭 2 バイトをアドレスとして受け取り、1 バイトごとにアドレスを進めて書く」を 64 KB の配列で行い、指定した番号の呼び出しだけは書かずに失敗を返す。

どのテストでも検査すること:

- 各塊のパケット長が 3 以上 2 + CHUNK 以下
- ctx がそのまま send に渡ること

### 成功する場合

- 戻り値 true、send の呼び出し回数 = ⌈size / CHUNK⌉
- 書き込んだ範囲が元データと一致し、範囲の直前・直後の 1 バイトは変わらない

| テスト | 先頭アドレス | size | 由来 |
|---|---|---|---|
| zero_bytes_sends_nothing | 0x2C34 | 0 | 塊を送らない(呼び出し 0 回) |
| one_byte | 0x7FFF | 1 | VL53L8CX_WrByte |
| exact_chunk | 0x2E18 | CHUNK | 境界 |
| chunk_plus_remainder | 0x2E18 | CHUNK+1 | 端数 |
| firmware_page_0x8000 | 0x0000 | 0x8000 | ファームウェア転送の 1 ページ |
| firmware_last_page_0x5000 | 0x0000 | 0x5000 | ファームウェア転送の最後のページ |
| default_configuration | 0x2C34 | 972 | 既定の設定(VL53L8CX_CONFIGURATION_SIZE) |

### 途中の塊が失敗する場合

size = 3 × CHUNK + 1(4 塊)、先頭アドレス 0x0000。k 番目(0 始まり)の呼び出しで失敗させる。

- 戻り値 false、send の呼び出し回数 = k + 1(失敗した塊の後は送らない)
- 先頭 k × CHUNK バイトだけが書かれ、それ以降は目印の 0xEE のまま

| テスト | k |
|---|---|
| first_chunk_fails | 0 |
| middle_chunk_fails | 1 |
| last_chunk_fails | 3(端数の 1 バイトの塊) |

### 引数が不正な場合

| テスト | 入力 | 期待値 |
|---|---|---|
| zero_max_chunk_fails | size 4、max_chunk 0 | 戻り値 false、send の呼び出し 0 回(無限ループにならない) |

## uld_i2c_timeout_us

| テスト | 入力 | 期待値 |
|---|---|---|
| zero_bytes_is_base | 0 | BASE |
| grows_per_byte | 2 / 258 | BASE + 2×PER / BASE + 258×PER |
| saturates | limit = (UINT32_MAX − BASE) / PER、limit+1、UINT32_MAX | BASE + limit×PER / UINT32_MAX / UINT32_MAX |

## uld_target_status_is_valid

| テスト | 入力 | 期待値 |
|---|---|---|
| valid_values | 5, 9 | true |
| invalid_neighbours | 0, 4, 6, 8, 10, 255 | false |
| only_two_valid | 0〜255 すべて | true になるのは 2 個だけ |

## 検出力の確認(変異テスト)

`src/uld_util.c` に次の変異を 1 つずつ入れて、どれも FAIL になることを確認した(2026-09-27)。分割書き込みの変異は、`uld_write_chunked` に移した後に確認した。

| 変異 | FAIL したテストの例 |
|---|---|
| swap のループ条件 `i + 4u <= size` → `<` | reverses_each_4_bytes |
| swap の 2 バイト目の入れ替えをなくす | reverses_each_4_bytes ほか |
| chunk_len が常に max_chunk を返す | chunk_len_one_over、wrmulti_one_byte ほか |
| write_chunked で send の失敗を無視して送り続け、最後に true を返す | first / middle / last_chunk_fails |
| write_chunked で send の失敗を覚えて送り続け、最後に false を返す | first / middle_chunk_fails(呼び出し回数) |
| write_chunked の最後の return true → false | wrmulti_*(成功する場合すべて) |
| write_chunked の max_chunk = 0 で true を返す | zero_max_chunk_fails |
| chunk_reg が offset を足さない | chunk_reg_adds_offset、wrmulti_chunk_plus_remainder ほか |
| pack_write のアドレス上位バイトに下位バイトを入れる | address_big_endian、wrmulti_* |
| timeout の飽和処理をなくす | saturates |
| timeout の飽和の境界 `>` → `>=` | saturates |
| 有効ステータス 9 → 6 | valid_values、invalid_neighbours |

## depth_view

段階の境界と 4x4 のモノクロ表示の期待文字列は `tools/verification/verify_depth_view_expected_values.py` で検算した(`python tools/verification/verify_depth_view_expected_values.py` で出力を再現できる)。表示の設定は、特に書かない限り sigma 上限 50 mm、距離の上限 2000 mm。

### depth_view_classify

| テスト | 入力(ステータス, ターゲット数, sigma, sigma 上限) | 期待値 |
|---|---|---|
| valid_status_5_and_9 | (5, 1, 10, 50) / (9, 1, 10, 50) | VALID |
| sigma_boundary | (5, 1, 50, 50) / (5, 1, 51, 50) | VALID / SIGMA_OVER(上限ちょうどは有効) |
| no_target | (5, 0, 10, 50) / (255, 1, 10, 50) | NO_TARGET(ターゲット数 0 またはステータス 255) |
| bad_status_before_sigma | (6, 1, 10, 50) / (13, 1, 10, 50) / (6, 1, 999, 50) | BAD_STATUS(sigma 超過よりステータス無効を優先。6 / 13 は起動直後の 1 フレーム目に出る値) |

### depth_view_zone_at / depth_view_zone0_corner

| テスト | 入力(side, 行, 列, 左右反転, 上下反転) | 期待値 |
|---|---|---|
| no_flip | (8, 0, 0) / (8, 0, 7) / (8, 7, 0) / (8, 2, 3)、反転なし | 0 / 7 / 56 / 19 |
| flips | (8, 0, 0) を h / v / h+v | 7 / 56 / 63 |
| | (8, 2, 3) を h / v / h+v | 20 / 43 / 44 |
| | (4, 1, 2) を h+v | 9 |
| is_bijection | side 1〜8 × 反転 4 通り | 全ゾーンがちょうど 1 回ずつ出る |
| zone0_corner_matches_zone_at | 反転 4 通り | top-left / top-right / bottom-left / bottom-right。zone_at でゾーン 0 が来る位置と一致 |

### depth_view_level

| テスト | 入力(距離, 上限) | 期待値 |
|---|---|---|
| boundaries_2000 | 0 / 250 / 251 / 1750 / 1751 / 2000(上限 2000) | 0 / 0 / 1 / 6 / 7 / 7 |
| out_of_range_and_negative | 2001 / −5(上限 2000) | 8(範囲外)/ 0 |
| extreme_ranges | (0, 0) / (1, 0) / (32767, 65535) | 0 / 8 / 3 |

上限 2000 の段階の範囲: 0: 0〜250、1: 251〜500、2: 501〜750、3: 751〜1000、4: 1001〜1250、5: 1251〜1500、6: 1501〜1750、7: 1751〜2000(検算スクリプトの出力)。

### depth_view_stats

| テスト | 入力(4x4) | 期待値 |
|---|---|---|
| counts_and_sigma | ステータス有効 4 ゾーン(sigma 30, 10, 20, 40)、ステータス 6 が 1、sigma 60 が 1、残り 10 はターゲットなし | VALID 4、BAD_STATUS 1、SIGMA_OVER 1、NO_TARGET 10、status_ok 5、max 60、中央値 30 |
| even_count_lower_median | ステータス有効 4 ゾーン(sigma 30, 10, 20, 40)、残りはターゲットなし | status_ok 4、max 40、中央値 20(偶数個は小さい側) |
| no_status_ok | 8x8 全ゾーンがステータス 6 | BAD_STATUS 64、status_ok 0、max 0、中央値 0 |

### depth_view_render

4x4 のパターン: ゾーン i の距離 = i × 100 mm、ゾーン 5 はステータス 6(`x`)、6 は sigma 60(`?`)、7 はターゲットなし(空白)。

| テスト | 入力 | 期待値 |
|---|---|---|
| mono_4x4_exact | パターン、モノクロ、反転なし | 全文が一致(上下の目印、枠、2 行目に `9pin` / `4pin`、各ゾーン `" " + 濃淡の文字 + cm 3 桁`、凡例 `[cm] near @%#*+=-: far .=>2000mm x=status ?=sigma>50mm blank=none`) |
| mono_4x4_flipped_rows | パターン、モノクロ、h+v | 1 行目がゾーン 15, 14, 13, 12、目印の行がゾーン 11, 10, 9, 8 |
| mono_has_no_escape | パターン、モノクロ | ESC を含まない |
| color_cells | パターン、カラー | 先頭が ESC[H、ゾーン 0 は背景 196 / 文字 16 で `   0`、ゾーン 5 は背景 240 / 文字 231 で `  x `、ゾーン 15(1500 mm、段階 5)は背景 46 で ` 150`、行末は ESC[0m + 右の目印 + ESC[K + 改行 |
| color_out_of_range | パターンのゾーン 0 を 2500 mm | 背景 53(暗い紫)/ 文字 231 で ` 250` |
| mono_cm_clamp_and_negative | ゾーン 0 を 12000 mm、ゾーン 1 を −20 mm | `.999`(範囲外、999 cm で頭打ち)、`@  0`(負は 0) |
| worst_case_fits | 8x8 カラーで全ゾーン無効(色指定が最長の 20 バイト)/ 全ゾーン範囲外 | 各行 ≤ DEPTH_VIEW_LINE_MAX(256)、行数 ≤ 13、全体 < DEPTH_VIEW_RENDER_BUF_SIZE |
| random_frames_fit | 固定シードの乱数フレーム 400 個(辺 1〜8、表示の設定 8 通り、距離 −1000〜32767 mm(int16_t で表せる範囲だけを生成)、ステータス 5/9/6/13/255/乱数、sigma 0〜199、sigma の上限 0〜99、距離の上限 0〜4999) | 上と同じ上限を満たし、戻り値 = strlen、バッファの外(16 バイト)を書かない |
| fits_80_columns | 8x8、カラー / モノクロ、両反転、sigma と距離の上限 65535(凡例が最長)。全ゾーン無効 / 全ゾーン範囲外(上限 100)/ 全ゾーン有効 | 各行の見た目の桁数(ANSI エスケープと改行を除く)≤ 80、ESC 以外は印字可能な ASCII だけ |
| rejects_small_buffer | バッファ長 DEPTH_VIEW_RENDER_BUF_SIZE − 1 / 0 | 0 を返す。前者は buf[0] だけ NUL にして残りは変えない、後者は何も書かない |
| rejects_bad_side | side 0 / 9 | 0 を返し、空文字列 |

### depth_view_render_status / depth_view_help_text / depth_view_fps_x10

| テスト | 入力 | 期待値 |
|---|---|---|
| status_typical_exact | フレーム 123、31℃、15.0 fps、read 11205 µs、draw 3400 µs、452 B、エラー 0 / 2、有効 61・x 1・? 1・none 1、sigma 中央値 18・最大 80、h=1 v=0、モノクロ | 4 行の全文が一致(read は `11.20 ms`、draw は `3 ms`) |
| status_read_ms_leading_zero_and_negative_temp | フレーム 1(warming up)、−5℃、read 10050 µs、h=0 v=1、カラー | `frame 1 (warming up) \| temp -5C \| zone0 bottom-left (h=0 v=1)` + ESC[K、`read 10.05 ms`(小数 2 桁目の 0 を落とさない) |
| status_worst_case_fits_80_columns | フレーム番号・時間・バイト数・エラー数を uint32_t の最大、温度 −128、fps × 10 を uint32_t の最大、分類ごとの数 64、sigma 65535、表示の設定 8 通り | 各行 ≤ 80 桁、ASCII のみ、バッファの外を書かない。`zone0 bottom-right (h=1 v=1)` と `9999.9 fps`(頭打ち)が出る |
| status_rejects_small_buffer | バッファ長 DEPTH_VIEW_STATUS_BUF_SIZE − 1 | 0 を返し、buf[0] だけ NUL |
| help_fits_80_columns | ヘルプの本文 | 各行 ≤ 80 桁、ESC を含まない |
| fps_x10 | (15 フレーム, 1000000 µs) / (14, 933333) / (14, 933334) / (0, 1000) / (15, 0) / (15, 1) / (UINT32_MAX, 1) | 150 / 150 / 149 / 0 / 0 / 99999 / 99999 |

8x8 で実際に生成される長さ(参考。scratch のプログラムで測定): モノクロ 641 バイト、カラー 1832 バイト、全ゾーン無効のカラー 1913 バイト(最長の行 214 バイト)。バッファは 3332 バイト。

### 検出力の確認(depth_view)

`src/depth_view.c` に次の変異を 1 つずつ入れて、どれも検出されることを確認した(2026-09-27)。

| 変異 | 検出したテスト |
|---|---|
| sigma の判定 `>` → `>=` | classify_sigma_boundary |
| sigma の判定をステータスの判定より前にする | classify_bad_status_before_sigma |
| ステータス 255 をターゲットなしにしない | classify_no_target |
| 左右反転で列の代わりに行を使う | zone_at_flips、zone_at_is_bijection ほか |
| 段階の除数 `range_max_mm + 1` → `range_max_mm` | テストが異常終了(上限 0 で 0 除算)。上限 2000 の境界のテストでも差が出る |
| 範囲外の判定 `>` → `>=` | level_boundaries_2000、level_extreme_ranges |
| 中央値を大きい側にする | stats_even_count_lower_median |
| ソートの向きを逆にする | stats_counts_and_sigma ほか |
| バッファ長の事前検査をなくす | render_rejects_small_buffer |
| zone0_corner の下側 2 つを入れ替える | zone0_corner_matches_zone_at |
| 濃淡の文字を 1 段ずらす | render_mono_4x4_exact ほか |
| 目印を出す行を side / 2 にする | render_mono_4x4_exact ほか |
| ヘルプに 80 桁を超える行を足す | help_fits_80_columns |
| read の小数 2 桁目の 0 埋めをなくす | status_read_ms_leading_zero_and_negative_temp |
| fps_x10 の頭打ちをなくす | fps_x10 |
| ステータス行の fps の頭打ちをなくす | status_worst_case_fits_80_columns |
| 凡例を長くする("blank=no target at all") | render_mono_4x4_exact、render_fits_80_columns |
| 範囲外の色を 17 に戻す | render_color_out_of_range |
