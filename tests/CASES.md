# テストケース対応表

`tests/test_uld_util.c` の各テストが検証している入力と期待値。対象は `src/uld_util.c`(Pico SDK に依存しない部分)。

## ビルド構成

`make test` は同じテストを 2 つの構成でビルドして実行する。

| 実行ファイル | 構成 |
|---|---|
| `build-host/test_uld_util` | 既定(分割書き込みの塊 `ULD_WRITE_CHUNK_BYTES` = 256) |
| `build-host/test_uld_util_small` | `-DULD_WRITE_CHUNK_BYTES=7u`。0x8000 などの長さが塊の長さで割り切れない場合を通す |

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
