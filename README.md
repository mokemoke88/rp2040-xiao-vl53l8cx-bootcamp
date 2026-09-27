# xiao-vl53l8cx-bootcamp

XIAO RP2040 と VL53L8CX(8x8 マルチゾーン ToF)で「LiDAR っぽい」技術デモを作る。段階的な課題(Step)を積み上げ、最後に1本のデモにまとめる。

## 参照元アイデア

- なし(会話での相談から直接ワークスペース化)
- 近いテーマ: `ideas/2026-07-11-microcontroller-rc-brainstorm.md` の「LiDAR」軸(紐づけはしていない)

## 決定事項

- ハードウェアは **本体 2 つのみ**: Seeed Studio XIAO RP2040 + Pololu VL53L8CX キャリア基板。サーボ・ディスプレイ等の追加部品は使わない
- 表示は **PC 側**。マイコンは USB CDC でフレームを送り、**ブラウザ(Web Serial API + three.js)** で可視化する。Web Serial は Chromium 系ブラウザ(Chrome / Edge)が前提
- センサーとの接続は **I2C、クロックは 400 kHz**。ブレッドボードで組むため、センサーとマイコンが対応する 1 MHz(Fast-mode Plus)は使わず控えめにする。帯域が足りなければ 1 MHz や SPI を検討
- ファームウェアは Pico SDK(C)。ビルド構成は `workspaces/rp2040/xiao-takeover-ctrl` を踏襲する
- センサードライバは ST 公式の ULD(STSW-IMG040 v2.0.1、ドライバ本体 2.0.0、BSD-3-Clause)を `third_party/vl53l8cx_uld/` に置く。出どころと、1 ファイル差し替えた理由は同ディレクトリの README

## 配線

Pololu VL53L8CX キャリア(#3419)のピン名は基板のシルクどおり。回路図: https://www.pololu.com/file/0J2031/vl53l8cx-time-of-flight-sensor-schematic.pdf

| キャリア | XIAO RP2040 | 備考 |
|---|---|---|
| VIN | 3V3 | **3V3 から取る**。キャリアのロジック High は VIN の電圧になる(レベルシフタ NXS0108 の外側が VIN)。5V を入れると XIAO の I/O に 5V がかかる |
| GND(9 ピン側・4 ピン側とも) | GND | |
| SDA | D4(GPIO6) | I2C1 |
| SCL | D5(GPIO7) | I2C1 |
| INT | D0(GPIO26) | 割り込み出力。使わなければポーリングで代用できる |
| ~LP | D1(GPIO27) | Low で I2C 通信を止める(キャリア上でプルアップ済み) |
| **SPI/~I2C** | **GND** | **キャリア上でプルアップされていて既定は SPI**。I2C で使うには必ず GND に落とす(隣の GND ピンとジャンパで短絡すればよい) |
| CORE/IOVDD、AVDD | 接続しない | キャリア上の LDO 出力(1.8 V / 3.3 V) |
| MISO、~CS、SYNC | 接続しない | SPI 用と外部同期用 |

- ロジックピンはすべてキャリアのレベルシフタでプルアップされているので、外付けのプルアップは不要
- I2C アドレスは 7 bit で 0x29。Pololu と ST ULD(`VL53L8CX_DEFAULT_I2C_ADDRESS` = 0x52)は 8 bit 表記なので、Pico SDK に渡すときは 1 bit 右シフトする
- D2 / D3(ADC)と SPI0(D8〜D10)は空けておく
- 気になる点: VIN = 3.3 V だと、AVDD の LDO はドロップアウト分だけ 3.3 V を下回る(Pololu の VIN 下限は 3.2 V なので範囲内)。XIAO の 3V3 が測距中の電流(標準 100 mA、ピーク 150 mA)を賄えるかは未確認。動作が不安定なら疑う

## 段階構成

| Step | 内容 | 学ぶこと | 状態 |
|---|---|---|---|
| 1. 測距 | ULD ドライバを移植し、4x4 の距離を USB シリアルに printf | 配線、I2C、ULD のプラットフォーム層、センサーへのファームウェア転送 | 完了(2026-09-27。ゾーンの向きの確認は Step 2 に持ち越し) |
| 2. 距離画像 | 8x8 / 15 Hz にし、測距ステータスと sigma で無効ゾーンを除く。ターミナルに文字でヒートマップを出す | 解像度とレートの関係、測距データの信頼性 | 未着手 |
| 3. PC ヒートマップ | フレームをバイナリで送り(同期ヘッダ + 長さ + CRC)、ブラウザでリアルタイムにヒートマップ表示 | シリアルのフレーム設計、Web Serial | 未着手 |
| 4. 点群 | ゾーンの方向と距離から XYZ に変換し、three.js で 3D 点群表示(視点を回せる) | ToF の幾何(画角とゾーン中心の方向) | 未着手 |
| 5. 最終デモ | 「LiDAR 風ビュー」: 3D 点群 + 真上から見た扇形の 2D スキャン表示(列ごとの最近距離)+ 残像 + 動いたものの強調 | まとめ | 未着手 |

## 未決事項

- シリアルのフレーム形式の詳細(Step 3 で決める)
- ブラウザ側の構成(ビルドなしの素の ES Modules か、バンドラを使うか)と、それに対応する開発規約。`rules/develop/` に該当するものがまだない

## 対象と開発環境

- ボード: Seeed Studio XIAO RP2040
- SDK: Pico SDK 2.3.1(C)。CMake では `-DPICO_BOARD=seeed_xiao_rp2040` を必ず指定する
- ツールチェーンの入手先とボード固有の注意点は、knowledge の次の記事を参照:
  - `pico-sdk-windows-toolchain-sources`
  - `xiao-rp2040-pico-sdk-notes`
- 開発規約(ファームウェア): `rules/develop/c.md` + `rules/develop/c-pico-sdk.md`
- ホストでテストできるロジック(フレームのエンコード、CRC、ゾーン → XYZ 変換など)は SDK に依存させず、Unity でテストする

## ドキュメント

- [tests/CASES.md](tests/CASES.md) — ホストで単体テストする部分(`src/uld_util.c`)の入力と期待値、変異テストの結果
- [third_party/vl53l8cx_uld/README.md](third_party/vl53l8cx_uld/README.md) — ULD の出どころと差し替えたファイル

## ビルド・書き込み

### 必要なもの

- ファームウェア: `PICO_SDK_PATH`(Pico SDK 2.3.1)、Arm GNU Toolchain(`arm-none-eabi-gcc`)、CMake、Ninja。picotool はビルド済みのものを `picotool_DIR` で指定しておく
- ホスト側のテスト・整形: `gcc`、`make`(Windows では w64devkit で確認)、`clang-format`

### コマンド

すべてワークスペース直下で実行する。

| コマンド | 内容 |
|---|---|
| `make format` | clang-format で整形(`include/` `src/` `tests/` のみ。`third_party/` は対象外) |
| `make lint` | 整形済みか検査(差分があれば失敗) |
| `make test` | `src/uld_util.c` をホストの gcc でビルドし、Unity のテストを実行。分割書き込みの塊の長さを既定(256)と 7 の 2 構成でビルドして両方実行する。成果物は `build-host/` |
| `make firmware` | `cmake -S . -B build -G Ninja -DPICO_BOARD=seeed_xiao_rp2040` + `cmake --build build`。`build/xiao_vl53l8cx_bootcamp.uf2` ができる |

コードを変更したら `make format` → `make lint` → `make test` を1つずつ実行し、警告なし・全 PASS を確認する。ファームウェア側を変えた場合は `make firmware` も警告なしで通ること。`-Wall -Wextra` は自作のソースだけに付けている(ULD と SDK には付けない)。

### 書き込みと表示

1. XIAO の B(BOOT)ボタンを押しながら USB で PC に接続する(または接続中に B を押したまま R を押して離す)
2. `RPI-RP2` ドライブが現れるので、`build/xiao_vl53l8cx_bootcamp.uf2` をコピーする。コピーが終わると自動で再起動する
3. 出力は USB CDC(仮想 COM ポート)。ターミナルソフトで開く(ボーレートの設定は関係ない)。起動後 3 秒まではターミナルの接続を待つので、その間に開けば初期化のログから見られる

表示の例(値は説明用):

```
xiao-vl53l8cx-bootcamp step 1 (ULD VL53L8CX_2.0.0)
I2C bus recovery: 0 clocks, STOP sent, SDA=1 SCL=1
I2C1 399361 Hz (requested 400000 Hz)
sensor alive
init done in 2000 ms
ranging 4x4 @ 10 Hz ('!' = target_status other than 5/9)
frame 1 temp=30C
    312/  5     305/  5  ...
```

- 各ゾーンは `距離[mm]/測距ステータス`。ステータスが 5 / 9 以外のゾーンには `!` を付ける(255 はターゲットなし)
- `I2C bus recovery` はバス復旧(下記「設計メモ」)の結果。SDA が Low のまま起動したときだけ clocks が 1 以上になる
- `I2C1 ... Hz` は i2c_init が返す実際のクロック。既定の clk_sys 125 MHz では 399361 Hz になる見込み(SDK の i2c_set_baudrate の計算: period = (125000000 + 200000) / 400000 = 313 クロック、125000000 / 313 = 399361)
- ゾーン番号 i を i / 4 行目・i % 4 列目に並べている。センサーの向きと表示の上下左右の対応は未確認
- 初期化に失敗すると赤 LED が点き、`FAILED: <処理> status=<値> (last_i2c_error=..., i2c_error_count=...)` を 2 秒ごとに表示し続ける。測距が始まると緑 LED が点く

### 実機で確認すること

確認済みと書いているのは、ユーザーから報告があった範囲だけ。

- 4x4 の距離が 10 Hz で表示され続けること
  - 確認済み(2026-09-27、ユーザー報告: COM7 で frame 1260 台まで安定して出ていた。ステータスはほぼ 5、近距離で 9)
- ファームウェア転送を 256 バイトずつに分けて書き込んでも、`vl53l8cx_init` のチェックサム確認(`VL53L8CX_STATUS_FW_CHECKSUM_FAIL` = 5)を通ること
  - 確認済み(同上。測距が始まっていることから)
- 起動直後のログ: `sensor alive`、`init done in ... ms`(400 kHz で約 2 秒の見込み)、`I2C1 ... Hz`(399361 Hz の見込み)、`I2C bus recovery` の行
  - 確認済み(2026-09-27): `I2C1 399361 Hz`、`sensor alive`、`init done in 2621 ms`。起動直後の 1 フレーム目はステータス 6 / 13(無効)で、2 フレーム目から 5 になる
- 手をかざすと近くのゾーンの距離が変わること — 確認済み(2026-09-27。センサーの保護テープの有無で目立った差はなかった)
- ゾーンの並びとセンサーの向きの対応 — 未確認。4x4 のテキストでは手の位置との対応が読み取りにくかったので、Step 2 のヒートマップで確認する
- 測距中に R ボタン、または BOOTSEL での再書き込みでリセットした後、正常に再起動すること(`I2C bus recovery` の clocks と、その後の `sensor alive`)
  - 確認済み(2026-09-27、R ボタンで 2 回): どちらも再起動して測距を再開した。ログが取れた回は `0 clocks`(バスは固着していなかった)。固着からの復旧そのものはまだ起きていない
- XIAO の 3V3 から給電して、長時間の測距中にリセット・NACK(`check_data_ready error`)が出ないこと — 未確認(上記の約 2 分間は出ていない)
- LPn と LED の状態(下記「出力ピンの状態」)— 未確認

### 出力ピンの状態

このファームが操作する出力は、センサーの LPn(GPIO27)とオンボード RGB LED(赤 GPIO17 / 緑 GPIO16 / 青 GPIO25、アクティブ Low)だけ。

| 状況 | LPn | LED |
|---|---|---|
| リセット中(RUN ピン Low、再書き込み後の再起動を含む) | MCU は駆動しない。RP2040 のピンはリセット既定で入力・内蔵プルダウン有効(PADS_BANK0 の PDE のリセット値が 1)。キャリア上のプルアップとの兼ね合いで決まるレベルは未確認 | 駆動しない(消灯のはず。内蔵プルダウン経由の電流で光るかは未確認) |
| 起動直後〜`sensor_pins_init()` の前(USB の接続待ち最大 3 秒を含む) | 同上(まだ触らない) | `leds_init()` で H(消灯)を書いてから出力にする |
| `sensor_pins_init()` 以降 | H を書いてから出力にし、以後 H のまま(Reset_Sensor は呼ばない) | 測距開始で緑点灯。初期化失敗時は `gpio_put_masked` で緑消灯・赤点灯を 1 回で行う |
| panic | 変えない(H のまま) | 変えない(その時の状態のまま) |

- panic は SDK の既定のまま。SDK の panic はメッセージを出した後 `_exit` を呼び、newlib 用の `_exit` は `__breakpoint()` を繰り返す(SDK の panic.c / newlib_interface.c で確認)。GPIO は触らない。デバッガ未接続時に BKPT がどう扱われるか(HardFault になるか)は未確認だが、どちらでも GPIO を変える処理はない
- ウォッチドッグは使っていないので、panic や無限ループからは自動で再起動しない
- センサーは MCU と独立に測距を続ける。MCU が止まっている間も LPn は H なので、センサーの I2C は有効なまま

## ファイル構成

```
CMakeLists.txt            ファームウェアのビルド定義(PICO_BOARD 既定 seeed_xiao_rp2040、ULD のソースを含む)
pico_sdk_import.cmake     Pico SDK 同梱のものをコピー($PICO_SDK_PATH/external/)
Makefile                  make test / format / lint(ホスト)、make firmware(CMake 呼び出し)
.clangd                   clangd がファームウェアのコンパイル DB(build/)を使う設定
LICENSE                   MIT
include/
  bootcamp_config.h       ピン番号、I2C のクロック、測距の頻度などの設定
  i2c_bus_recover.h       I2C バスの復旧(SCL の手動クロックと STOP)
  platform.h              ULD のプラットフォーム層(ULD が固定名で include する。出力の有効・無効もここで決める)
  uld_util.h              プラットフォーム層の SDK 非依存の部分(バイト順の入れ替え、分割書き込みのループ、タイムアウト、ステータス判定)
src/
  main.c                  初期化(USB CDC、LPn、I2C バス復旧、I2C1)→ ULD の初期化 → 4x4 の測距結果をポーリングして表示
  i2c_bus_recover.c       i2c_bus_recover.h の実装(GPIO でオープンドレインを模して操作)
  platform.c              VL53L8CX_RdByte / WrByte / RdMulti / WrMulti / WaitMs / SwapBuffer / Reset_Sensor の RP2040 実装
  uld_util.c              uld_util.h の実装(stdint.h / stdbool.h だけに依存。ホストでテストする)
tests/
  test_uld_util.c         Unity による単体テスト
  CASES.md                テストの入力と期待値の対応表
third_party/
  vl53l8cx_uld/           ST の VL53L8CX ULD 2.0.0(BSD-3-Clause。改変しない)
  unity/                  Unity(MIT)
```

### エディタ(clangd)

ワークスペース直下の `.clangd` が `build/compile_commands.json`(`make firmware` で生成)を参照する。arm-none-eabi-gcc の標準ヘッダを clangd に見つけさせるには、エディタ側で clangd の起動引数に `--query-driver=<arm-none-eabi-gcc のパス>*` を追加する。`tests/` はコンパイル DB に含まれないため、`.clangd` で Unity のインクルードパスを足している。

## 設計メモ(Step 1)

- ULD の I2C アドレスは 8 bit 表記(0x52)のまま `VL53L8CX_Platform.address` に持ち、Pico SDK に渡すときだけ 1 bit 右シフトする
- 読み出しは「レジスタアドレスを nostop で書く → RESTART → 読む」の 1 トランザクション。書き込みはレジスタアドレスとデータを 1 回の書き込みにまとめる(Pico SDK は nostop の次の書き込みの最初のバイトに RESTART ビットを立てるため。ビットを立てることは SDK のソースで確認、バス上の波形は未確認)。ファームウェア転送(1 回 0x8000 バイト)に備えて 256 バイトずつに分割し、塊ごとにレジスタアドレスを付け直して送る(`uld_write_chunked`。途中の塊が失敗したら残りは送らない)。センサーのアドレス自動インクリメントが前提で、ファームウェア転送が通ったことを実機で確認した。通らなくなった場合の代替は 0x8000 + 2 バイトの静的バッファで 1 トランザクションにすること(RAM 264 KB に対して 32 KB)
- SDK の `i2c_write_burst_blocking`(RESTART を付けずに続けて書ける)は、タイムアウト付きの版がないので使わない
- I2C 関数はタイムアウト付き(`i2c_*_timeout_us`)を使う。タイムアウトは 10 ms + 転送バイト数 × 100 µs。失敗したら ULD には 255 を返し、SDK の戻り値を `last_i2c_error` に残す
- 測距結果の出力は距離・測距ステータス・sigma・ターゲット数だけを有効にしている(`include/platform.h`)。ターゲット数は、ULD がターゲットなしのゾーンのステータスを 255 にするのに使う
- SDA / SCL / INT / LPn の内蔵プルダウン(RP2040 のリセット既定)は外す。プルアップはキャリア基板側にある
- 起動時に I2C バスを復旧してから I2C1 を使い始める(`src/i2c_bus_recover.c`)。測距中に MCU だけがリセットされると、センサーが読み出しの途中で SDA を Low に保持したままになりうる。SDK の I2C 関数はタイムアウトしても abort も STOP もしない(i2c.c)ので、そのままでは is_alive で止まる。SDA / SCL を GPIO にして、SDA が Low の間 SCL を最大 9 回クロックし、SDA が High になったら STOP を出す。手動クロックは約 100 kHz(半周期 5 µs)で、SCL を離した後は最大 1 ms まで High になるのを待つ(クロックストレッチ対策)
- ULD との境界(`VL53L8CX_WaitMs` の `sleep_ms`、`vl53l8cx_init` などの ULD の関数)はブロッキングを許容する。ULD がブロッキングで書かれているため、c-pico-sdk.md の「待ちはブロッキングにしない」の例外とする。メインループのデータ待ちも `sleep_ms` によるポーリング
