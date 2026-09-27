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
| 2. 距離画像 | 8x8 / 15 Hz にし、測距ステータスと sigma で無効ゾーンを除く。ターミナルに文字でヒートマップを出す | 解像度とレートの関係、測距データの信頼性 | 完了(2026-09-27) |
| 3. PC ヒートマップ | フレームをバイナリで送り(COBS + CRC-32。形式は [docs/frame-format.md](docs/frame-format.md))、ブラウザでリアルタイムにヒートマップ表示(距離と signal_per_spad の「IR 画像」) | シリアルのフレーム設計、Web Serial | 完了(2026-09-27。バイナリ出力は拒否 0・欠落 0・15.2 fps、ブラウザでの接続・表示・切断・抜き差しを確認。残りの確認項目は下記「実機で確認すること」) |
| 4. 点群 | ゾーンの方向と距離から XYZ に変換し、three.js で 3D 点群表示(視点を回せる) | ToF の幾何(画角とゾーン中心の方向) | 未着手 |
| 5. 最終デモ | 「LiDAR 風ビュー」: 3D 点群 + 真上から見た扇形の 2D スキャン表示(列ごとの最近距離)+ 残像 + 動いたものの強調 | まとめ | 未着手 |

## 未決事項

- なし(ブラウザ側の構成は Step 3 で決定: Vite + TypeScript、UI フレームワークなし。開発規約は `rules/develop/typescript-vite.md`)

## 対象と開発環境

- ボード: Seeed Studio XIAO RP2040
- SDK: Pico SDK 2.3.1(C)。CMake では `-DPICO_BOARD=seeed_xiao_rp2040` を必ず指定する
- ツールチェーンの入手先とボード固有の注意点は、knowledge の次の記事を参照:
  - `pico-sdk-windows-toolchain-sources`
  - `xiao-rp2040-pico-sdk-notes`
- 開発規約(ファームウェア): `rules/develop/c.md` + `rules/develop/c-pico-sdk.md`
- 開発規約(ブラウザ、`web/`): `rules/develop/typescript-vite.md`(Vite の概要はリポジトリの `docs/vite-overview.md`)
- ホストでテストできるロジック(フレームのエンコード、CRC、ゾーン → XYZ 変換など)は SDK に依存させず、Unity でテストする

## ドキュメント

- [docs/frame-format.md](docs/frame-format.md) — PC へ送るバイナリメッセージの形式(版 1)。ペイロード、CRC-32、COBS、受信側が拒否する条件、モードの切り替え
- [docs/frame-vectors.json](docs/frame-vectors.json) — 形式のテストベクタ(`tools/gen_frame_vectors.py` が生成。C と Python のデコーダ、ブラウザ側のテストが使う)
- [tests/CASES.md](tests/CASES.md) — ホストで単体テストする部分(`src/uld_util.c`、`src/depth_view.c`、`src/frame_proto.c`)の入力と期待値、変異テストの結果
- `tools/verification/verify_depth_view_expected_values.py` — depth_view のテストの期待値(距離の段階の境界、4x4 の表示文字列)の検算
- `tools/verification/estimate_ranging_read_time.py` — 1 フレームの読み出しバイト数と I2C の転送時間の見積もり(下記「設計メモ(Step 2)」「設計メモ(Step 3)」)
- `tools/verification/decode_capture.py` — USB シリアルの記録をデコードして統計を出す(C とは別に書いたデコーダ。テストベクタで自己検査する)
- [third_party/vl53l8cx_uld/README.md](third_party/vl53l8cx_uld/README.md) — ULD の出どころと差し替えたファイル

## ビルド・書き込み

### 必要なもの

- ファームウェア: `PICO_SDK_PATH`(Pico SDK 2.3.1)、Arm GNU Toolchain(`arm-none-eabi-gcc`)、CMake、Ninja。picotool はビルド済みのものを `picotool_DIR` で指定しておく
- ホスト側のテスト・整形: `gcc`、`make`(Windows では w64devkit で確認)、`clang-format`
- ブラウザアプリ(`web/`): Node.js(v24 で確認)と npm。表示には Chrome または Edge(Web Serial は Chromium 系のみ)
- Python 3(`make test` がテストベクタの確認とデコーダの自己検査に使う)。記録ツールは pyserial が要る(リポジトリルートの `.venv` に入っている。`make` の `PYTHON` 変数で別の python を指定できる)

### コマンド

すべてワークスペース直下で実行する。

| コマンド | 内容 |
|---|---|
| `make format` | clang-format で整形(`include/` `src/` `tests/` のみ。`third_party/` は対象外) |
| `make lint` | 整形済みか検査(差分があれば失敗) |
| `make test` | `src/uld_util.c` / `src/depth_view.c` / `src/frame_proto.c` をホストの gcc でビルドし、Unity のテストを実行。uld_util は分割書き込みの塊の長さを既定(256)と 7 の 2 構成でビルドして両方実行する。続けて、テストベクタが生成スクリプトと一致するか(`gen_frame_vectors.py --check`)と、デコーダの自己検査(`decode_capture.py --self-test`)を行う。成果物は `build-host/` |
| `make vectors` | テストベクタ(`docs/frame-vectors.json`、`tests/frame_vectors.h`)を作り直す(`tools/gen_frame_vectors.py` を変えたとき) |
| `python tools/capture_serial.py --port COM7 --seconds 5 --out capture.bin` | バイナリの出力を記録する(開いた後に `b` を送り、終わったら `t` を送ってテキストに戻す。DTR を立てて開く。Ctrl-C で止めてもそれまでの記録を書き出す) |
| `python tools/verification/decode_capture.py capture.bin` | 記録をデコードして統計(メッセージ数、fps、フレーム間隔の最小・最大、seq の欠落・後退、CRC / COBS などの拒否の数)を出す。`--show N` で先頭 N フレームの中身も出す。自己検査は、テストベクタ(メッセージ、拒否すべきバイト列、複数メッセージを連結したストリームの統計)と、仕様書に手で書いた 16 進の例との一致を確かめる |
| `python tools/verification/verify_depth_view_expected_values.py` | depth_view のテストの期待値を出力する(テストに書いた値と照合する) |
| `python tools/verification/estimate_ranging_read_time.py` | 4x4 / 8x8 の 1 フレームの読み出しバイト数と I2C の転送時間の見積もりを出力する |
| `make firmware` | `cmake -S . -B build -G Ninja -DPICO_BOARD=seeed_xiao_rp2040` + `cmake --build build`。`build/xiao_vl53l8cx_bootcamp.uf2` ができる |

コードを変更したら `make format` → `make lint` → `make test` を1つずつ実行し、警告なし・全 PASS を確認する。ファームウェア側を変えた場合は `make firmware` も警告なしで通ること。`-Wall -Wextra` は自作のソースだけに付けている(ULD と SDK には付けない)。

### 書き込みと表示

1. XIAO の B(BOOT)ボタンを押しながら USB で PC に接続する(または接続中に B を押したまま R を押して離す)
2. `RPI-RP2` ドライブが現れるので、`build/xiao_vl53l8cx_bootcamp.uf2` をコピーする。コピーが終わると自動で再起動する
3. 出力は USB CDC(仮想 COM ポート)。ターミナルソフトで開く。起動後 3 秒まではターミナルの接続を待つので、その間に開けば初期化のログから見られる

#### PuTTY の設定

- Session: Connection type = **Serial**、Serial line = XIAO の COM ポート(例 `COM7`)。Speed の値は USB CDC なので関係ない(既定の 9600 のままでよい)
- Connection > Serial: Flow control = **None** を推奨
- 色は ANSI 256 色(`ESC[48;5;Nm` など)を使う。PuTTY は Window > Colours の "Allow terminal to use xterm 256-colour mode" が既定で有効
- 出力は ASCII だけ(罫線は `+ - |`)なので、Window > Translation の文字コードの設定に依存しない
- 改行は "\r\n" で届く。Pico SDK の stdio は、USB の出力で "\n" を "\r\n" に変換する設定が既定で有効(`PICO_STDIO_ENABLE_CRLF_SUPPORT` = 1、`PICO_STDIO_DEFAULT_CRLF` = 1、USB 用の `PICO_STDIO_USB_DEFAULT_CRLF` の既定は `PICO_STDIO_DEFAULT_CRLF`。SDK の stdio.h / stdio_usb.h / stdio.c で確認)。PuTTY の "Implicit CR in every LF" は不要
- 1 文字コマンドは、PuTTY がキーを押すたびに 1 文字ずつ送る前提(Serial 接続では既定でローカルの行編集が働かない前提。PuTTY の文書では確認していない)。Enter は不要。Enter を押すまで効かない場合は、Terminal > Line discipline options の Local line editing を Force off にする
- ログを取る場合(serial-read スキルなど)は、Pico の USB CDC は DTR が立たないと出力しないので DTR を立てて開く。解析用には `c` でモノクロにする

#### 操作キー

| キー | 動作 |
|---|---|
| `h` / `H` | 左右反転を切り替える |
| `v` / `V` | 上下反転を切り替える |
| `c` / `C` | カラー(ANSI 256 色、画面を上書き)とモノクロ(ANSI エスケープなし、流れる)を切り替える |
| `?` | ヘルプを表示する(約 5 秒、または何かキーを押すまで距離画像の表示を止める) |
| `b` / `B` | バイナリの出力に切り替える(ブラウザや記録用。[docs/frame-format.md](docs/frame-format.md))。ターミナルでは読めない文字が流れる |
| `t` / `T` | バイナリからテキストの表示に戻す |

バイナリの出力中は `h` / `v` / `b` / `t` だけが効く(`h` / `v` は反転を変えて状態メッセージを送り直す)。`c` / `?` は無視する。起動ログやエラーはログのメッセージ(種別 2)で送り、ANSI エスケープやテキストは混ぜない。

起動時はカラー表示、左右反転あり・上下反転なし(h=1 v=0。下記「表示の読み方」の向きの確定値)。カラー表示では、起動後最初の描画・`c` でカラーに切り替えたとき・ヘルプの後に、画面全体を消し(`ESC[2J`)、以後はカーソルを左上に戻して(`ESC[H`)上書きする。各行の末尾で `ESC[K`、ステータス行の後で `ESC[J` を出し、前の表示の残りを消す。

#### 表示の読み方

モノクロ表示の例(8x8、既定の h=1 v=0。値は `depth_view_render` / `depth_view_render_status` に作ったデータを渡して生成したもので、実測ではない):

```
                           up
       +----------------------------------------+
       | .260 =138 +120 +102 * 84 # 66 % 48 % 30|
       | -160 =142 +124 +106 * 88 # 70 x    % 34|
       | -164 =146 =128 ?    * 92 # 74 # 56 % 38|
  9pin | -168 =150 =132 +114 * 96 * 78 # 60 % 42| 4pin
       | -172 -154 =136 +118 *100 * 82 # 64 % 46|
       | :176 -158 =140 +122 +104 * 86 # 68 % 50|
       | :180 -162 =144 =126 +108 * 90 # 72 # 54|
       |      -166 =148 =130 +112 * 94 * 76 # 58|
       +----------------------------------------+
                           down
[cm] near @%#*+=-: far .=>2000mm x=status ?=sigma>50mm blank=none
frame 123 | temp 31C | zone0 top-right (h=1 v=0)
15.0 fps | read 11.20 ms | draw 3 ms | 452 B/frame
valid 61/64 (x 1, ? 1, none 1) | errors ready 0 data 0
sigma of status-ok zones: median 19 max 80 limit 50 | keys h v c ?
```

- 画面は 8x8 で 17 行、各行は ANSI エスケープを除いて 80 桁以内(PuTTY の既定 80 x 24 に収まる。ヘルプも同じ。テストで最長の値の場合を検査している)
- 各ゾーンは距離 [cm]。モノクロは前に濃淡の文字(近い順に `@ % # * + = - :`、0〜2000 mm を 250 mm ごとの 8 段階。2000 mm 超は `.`)。カラーは背景色(近 = 赤 → 黄 → 緑 → 遠 = 青、2000 mm 超は暗い紫(256 色の 53)。段階 7 の青、無効の灰色と見分けられる色にしている)
- 無効なゾーン: `x` = 測距ステータスが 5 / 9 以外、`?` = ステータスは有効だが sigma が上限(既定 50 mm、暫定)を超える、空白 = ターゲットなし。カラーでは灰色の背景
- 枠の外の目印は、**センサーを自分に向けて、9 ピン列が左・4 ピン列が右になるように持ったとき**の物理的な向き(左 `9pin`、右 `4pin`、上 `up`、下 `down`)。目印は表示に固定で、反転しても動かない。反転で変わるのは、どのゾーンをどこに描くか。ステータス行の `zone0` は、センサーのゾーン 0 を描いている角
- **向きの確定値: 左右反転あり・上下反転なし(h=1 v=0)**(2026-09-27、ユーザー報告。PuTTY で、センサーを自分に向け 9 ピン列を左にして持ち、表示と見た目が一致した。離れて腕を振ると表示が追随した)。このとき **ゾーン 0 は、センサーを正面から見て 9 ピン列を左にしたときの右上** にあり、表示でも右上に描かれる。既定値は `include/bootcamp_config.h` の `BOOTCAMP_FLIP_H_DEFAULT` / `BOOTCAMP_FLIP_V_DEFAULT`
- ステータス行 1: フレーム番号(1 フレーム目は `(warming up)`。起動直後の 1 フレーム目はステータスが 6 / 13 で無効になる)、センサーの温度、ゾーン 0 の角と反転の状態
- ステータス行 2: 直近 15 フレームの合計時間から求めたフレームレート、`get_ranging_data` の所要時間、前のフレームの描画(文字列の組み立てと USB への出力)の所要時間、1 フレームで読むバイト数(ULD の `data_read_size`)
- ステータス行 3: 有効なゾーン数と無効の内訳、読み出しエラーの累計(`check_data_ready` と `get_ranging_data`)。エラーの行はカラー表示では次の描画で消えるので、累計で分かるようにしている
- ステータス行 4: ステータスが有効なゾーン(sigma で除く前)の sigma の中央値・最大と上限。sigma の上限を調整する目安にする
- 起動時のログはカラー表示の最初の描画で画面から消える。見たいときは PuTTY のスクロールバックを遡るか、モノクロ(`c`)に切り替えてからリセットする(serial-read でログを取る場合も同じ。ただし起動直後はカラーなので、ログには ANSI エスケープが入る)
- 初期化に失敗すると赤 LED が点き、`FAILED: <処理> status=<値> (last_i2c_error=..., i2c_error_count=...)` を 2 秒ごとに表示し続ける。測距が始まると緑 LED が点く
- 起動時のログ(`I2C bus recovery`、`I2C1 ... Hz`、`sensor alive`、`init done in ... ms`、`ranging 8x8 @ 15 Hz, N bytes per frame`)は Step 1 と同じ。`I2C1 ... Hz` は既定の clk_sys 125 MHz で 399361 Hz(SDK の i2c_set_baudrate の計算: period = (125000000 + 200000) / 400000 = 313 クロック、125000000 / 313 = 399361)。`N bytes per frame` は Step 3 で signal_per_spad と nb_spads_enabled を足したので 8x8 で 972 の見込み(下記「設計メモ(Step 3)」。上の例の 452 は Step 2 の値)

### ブラウザで表示する(web/、Step 3)

`web/` は Vite + TypeScript のブラウザアプリ。Web Serial で XIAO につなぎ、測距フレームを 3 つの 8x8 画像で表示する。規約は `rules/develop/typescript-vite.md`。

#### 起動

`web/` で次を実行する(初回だけ `npm install`)。

```
npm install
npm run dev
```

Chrome または Edge で **http://localhost:5173/** を開く。Web Serial は Chromium 系のブラウザで、secure context(https または localhost)でしか使えない。`npm run dev -- --host` で別の端末から `http://192.168.x.x:5173/` として開いた場合は接続できない(記録ファイルの再生は使える)。

| コマンド(`web/` で実行) | 内容 |
|---|---|
| `npm run dev` | 開発サーバー(http://localhost:5173/) |
| `npm run build` | 型チェックの後、`web/dist/` に静的ファイルを出力 |
| `npm run preview` | `dist/` をローカルで配って確認 |
| `npm run format` / `format:check` | Prettier で整形 / 整形済みか検査 |
| `npm run lint` | ESLint(typescript-eslint の型情報付きの規則) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest(`docs/frame-vectors.json` を読んで COBS・CRC・メッセージ・拒否・ストリームの統計を検査) |

コードを変更したら `npm run format` → `lint` → `typecheck` → `test` → `build` を 1 つずつ実行し、警告なし・全 PASS を確認する。

依存(すべて devDependencies): vite(開発サーバーとビルド)、typescript(`~6.0.2` に固定。typescript-eslint 8.x が 6.1 未満までしか対応しないため)、vitest(テスト)、eslint・@eslint/js・typescript-eslint(lint)、prettier(整形)、@types/w3c-web-serial(Web Serial の型)。

#### 接続

1. XIAO を USB でつなぐ(ターミナルソフトで同じ COM ポートを開いていたら閉じる。ポートは 1 つのアプリしか開けない)
2. 「接続」を押し、ダイアログで XIAO のポートを選ぶ
3. アプリはポートを開いて DTR を立て、`b` を送ってバイナリの出力に切り替える。最初の 0x00 までに届いたもの(テキスト表示の残り)は捨てる
4. 画像の左右・上下の反転は、データ源(接続・再生の開始)ごとの最初の状態メッセージでファームウェアの設定(既定 h=1 v=0)に合わせる。以後は画面のチェックボックスで切り替えてよい。状態メッセージが再送されても flags が前回と同じなら画面の設定は変えず、flags が変わったとき(ファームウェア側で `h` / `v` が押されたとき)だけ合わせ直す。反転が変わると、マウスが乗っている位置のゾーンの表示も求め直す
5. 「切断」で `t` を送ってテキスト表示に戻してから閉じる。接続直後の `b` の送信中に押した場合は、`b` の送信が終わってから `t` を送る。`t` は 500 ms 以内に送れなければあきらめ、送れていない書き込みを捨ててから閉じる。ポートを閉じる処理が 1 秒で終わらない場合も未接続に戻し、その旨をログに出す。USB を抜いた場合は、読み取りエラーとして記録して未接続に戻る
6. 接続から 3 秒たってもメッセージが来ない場合は、ログに注意を出す(ファームウェアがテキスト表示のまま、またはセンサーの初期化に失敗して止まっている。[docs/frame-format.md](docs/frame-format.md) の「モードの切り替え」)

#### 画面

- **距離**: 有効なゾーンは近 = 赤 → 黄 → 緑 → 遠 = 青(0〜2000 mm。Step 2 のターミナル表示と同じ考え方で、段階ではなく連続の色)。2000 mm 超は暗い紫。無効なゾーンは灰色の濃淡で、記号 `x` = ステータスが 5 / 9 以外、`?` = sigma が 50 mm 超、記号なし = ターゲットなし(判定の順も Step 2 と同じ)。「距離の数値」で有効なゾーンに mm の値を重ねる
- **signal_per_spad(IR 画像)**: グレースケール(黒 = 弱い、白 = 強い)。値の幅が広いので対数スケールで、範囲はフレームの最小・最大(0 を除く)に自動で追従する(広がるときはすぐ、狭まるときはゆっくり)。無効なゾーンも値のまま描く
- **nb_spads_enabled**: 青の濃淡(暗い = 少ない、明るい = 多い)。線形・自動レンジ
- 各画像の下に単位と凡例(色の帯と範囲)。T が 2 以上のフレームは最初のターゲットを描く
- 画像にマウスを乗せると、そのゾーンの全フィールド(全ターゲットの距離・ステータス・sigma・signal、ターゲット数、SPAD 数)を「ゾーン」の欄に出し、3 つの画像の同じゾーンを枠で示す
- 「受信」の欄: 受信 fps(ブラウザが受け取った頻度)、送信側 fps(タイムスタンプの間隔から)、種別ごとの受信数、seq の欠落(回数と個数)・後退、測距フレームの間隔の異常(状態メッセージの頻度から求めた周期の 1.5 倍超。センサー側の取りこぼしは seq に現れないのでこれで見る)、理由別の拒否の数、捨てたバイト数、温度
- 「状態メッセージ」の欄: ファームウェアの版、解像度、field_mask、測距の頻度、反転、I2C クロック、1 フレームの読み出しバイト数
- 「ログ」の欄: ファームウェアのログ(種別 2)と、ブラウザ側の出来事(接続・エラー)。最新 200 件

#### 記録ファイルの再生

`tools/capture_serial.py` で保存したファイル(USB シリアルの生のバイト列)を「記録ファイルの再生」で選び、「再生」を押す。実機なしで表示を確かめられる。

- 時間: 「記録時のタイムスタンプ」はメッセージの timestamp_us の間隔で流す(記録ファイルには受信時刻が入っていないため。間隔は 1 秒で頭打ち、時刻が戻ったところは待たない)。「一定(15 fps)」は測距フレームを 66.7 ms ごとに流す
- 速度(0.25〜4 倍)と繰り返しを選べる(再読み込みでブラウザがフォームの値を復元した場合も、起動時と再生の開始時に画面の値を読み直す)。接続中は再生できない。再生中に「接続」を押すと再生を止める
- 再生は実機と同じ受信処理(0x00 区切り → COBS → CRC → 形式の検査 → 統計)を通る
- 繰り返すときは、周の継ぎ目で受信処理・統計・表示をリセットし、新しいデータ源として始め直す(リセットしないと、前の周の末尾と次の周の先頭のテキストが 1 つのパケットとしてつながって拒否され、seq も後退として数えられる)。統計は周ごとの値になる

### 実機で確認すること

確認済みと書いているのは、ユーザーから報告があった範囲だけ。

#### Step 3(ファームウェア。未実施)

- テキスト表示が Step 2 と同じように動き、ステータス行 2 の `B/frame` が 972、fps が 15 前後のままであること(signal_per_spad と nb_spads_enabled を足した読み出しが 15 Hz に間に合うか)
- `read` の値。見積もりは I2C の転送だけで 22.0 ms 以上、Step 2 の実測との比で約 27.0 ms(下記「設計メモ(Step 3)」)
- `tools/capture_serial.py` で `b` を送って数秒記録し、`tools/verification/decode_capture.py` で全メッセージが拒否なし・シーケンスの欠落なしでデコードでき、最初に状態メッセージ、以後 15 fps 前後の測距フレームが並ぶこと
- バイナリの出力中に `t` でテキストに戻ること、`h` / `v` で状態メッセージが送り直されること
- 記録を止めたまま(ホストが読まない状態で)しばらく置いた後、読み始めると回復すること(下記「ホストが読まないとき」)

#### Step 3(ブラウザ)

Web Serial の接続ダイアログは自動化できないので、ブラウザでの確認はすべて手で行う。確認済みと書いたもの以外は未実施。

- `npm run dev` のページ(http://localhost:5173/)を Chrome / Edge で開き、「接続」でポートを選ぶと、状態メッセージの欄が埋まり、3 つの画像が 15 fps 前後で更新されること(受信 fps・送信側 fps が 15 前後、拒否 0、seq の欠落 0、間隔の異常 0)
- DTR の扱い: 接続後にメッセージが来ること(`setSignals({ dataTerminalReady: true })` が効くか。`open()` だけで DTR が立つかは未確認)
  - 確認済み(2026-09-27、ユーザー報告): 接続して表示が出た
- 向き: 既定(状態メッセージの flags、h=1 v=0)で、センサーを自分に向けて 9 ピン列を左にして持ったとき、手で隠した側が画像の同じ側に出ること。チェックボックスで反転を切り替えられること。なお 2 つ目以降の状態メッセージ(同じ flags の再送は画面の設定を残し、flags が変わったときだけ合わせ直す)は、ファームウェアが `b` / `h` / `v` を受け取ったときにしか送られない。ブラウザは接続時に `b` を 1 回送るだけで `h` / `v` を送る操作がなく、接続中はポートを PuTTY と共有できないので、いまの画面ではこの経路を確かめられない
- 距離の色(近 = 赤 → 遠 = 青、2000 mm 超の紫、無効の灰色と `x` / `?`)と「距離の数値」の切り替え
- signal_per_spad の IR 画像: 白い紙と黒い物、手を近づけたときに明暗が変わること。自動レンジの凡例の値が妥当か
- nb_spads_enabled: ゾーンや対象によって値が変わるか(変わらない場合は画像が一様になる。[docs/frame-format.md](docs/frame-format.md) ではこの挙動は未確認としている)
  - 観察(2026-09-27、ユーザー報告): 黒いピンセットでタバコをつまんで視野内で動かすと、ピンセットの部分が明るく(値が大きく)表示された。反射の弱い物で有効 SPAD 数が増える向き。色はフレームごとの自動レンジなので差の大きさはこの観察からは言えない。6 秒の記録では値は 3072〜4096 の 256 刻みで、単位が SPAD の個数そのものかは未確認
- マウスを乗せたゾーンの値の表示と、3 つの画像の枠の位置が一致すること
- 「切断」でテキスト表示に戻ること(切断後に PuTTY で開いてターミナルの表示が出る)
  - 確認済み(2026-09-27、ユーザー報告。このときの実装は切断処理のタイムアウト追加前)
- 接続直後(状態メッセージが出る前)にすぐ「切断」を押しても、テキスト表示に戻ること
- ファームウェアがセンサーの初期化に失敗した状態(赤 LED、テキストで `FAILED: ...` を出し続け、キーを受け付けない)で接続・切断したとき、3 秒後の注意が出ること、「切断」で固まらずに未接続に戻ること(`t` の送信は 500 ms、ポートを閉じる処理は 1 秒で打ち切る)
- 接続中に USB を抜いたとき、エラーをログに出して未接続に戻り、挿し直して再び接続できること(確認済み 2026-09-27、ユーザー報告)。再接続で `open` が失敗した場合(前のポートが閉じ切っていないと `InvalidStateError` になりうる)は、ログに「ポートを開けない(InvalidStateError: ...)」のようにエラーの名前と内容が出ること。そのときはページを再読み込みしてから接続し直す
- 接続後にメッセージが来ない場合(ファームウェアが初期化に失敗した状態など)に、3 秒後にログへ注意が出ること
- `tools/capture_serial.py` の記録ファイルを「記録ファイルの再生」で開き、記録時のタイムスタンプ・一定 15 fps の両方で再生できること。統計が `decode_capture.py` の出力と一致すること
- 描画の負荷: 長時間(数分)表示しても fps が落ちず、ブラウザのタブが重くならないこと

#### Step 2

- PuTTY でカラー表示とキー操作が動くこと — 確認済み(2026-09-27、ユーザー報告)
- 向きの確定 — 確認済み(2026-09-27、ユーザー報告): h=1 v=0 で一致。離れて腕を振ると表示が追随した
  - 手順: 30 cm 程度の距離で、センサーを自分に向けて 9 ピン列が左になるように持ち、9 ピン側の半分を手で隠す → 表示の左半分が近く(または無効)になるように `h` を合わせる。次に上半分を隠して `v` を合わせる
  - 隠した側が左右ではなく上下に出る(またはその逆)場合は、反転ではなく転置(行と列の入れ替え)が必要になる。今回のキャリアと持ち方では h / v だけで合ったので、転置の切り替えは用意していない
- 8x8 / 15 Hz で表示されること。ステータス行 2 の fps が 15 前後、`B/frame` が 452 であること
  - 確認済み(2026-09-27、serial-read で取得): 14.9〜15.1 fps、452 B/frame、`errors ready 0 data 0`。8x8 / 15 Hz の連続測距でセンサーの温度表示は 49 °C(Step 1 の 4x4 / 10 Hz では 28〜33 °C)
- `read` の値(見積もり: I2C の転送だけで 10.3 ms 以上)と、`draw` の値(下記「設計メモ(Step 2)」の見積もり)。両者の和が 66.7 ms に収まるか
  - 確認済み(同上): read 12.63 ms、draw はカラー 3 ms・モノクロ 2 ms。和は約 16 ms で、周期 66.7 ms に十分収まる
- `c` でモノクロに切り替えて流れ、もう一度 `c` でカラーに戻ること — 確認済み(同上。`c` を USB から送って確認)
- `?` のヘルプの後にカラー表示に戻ること、大文字のキー(`H` / `V` / `C`)も効くこと — 確認済み(2026-09-27、ユーザー報告)
- sigma の上限(暫定 50 mm)の妥当性。ステータス行 4 の中央値・最大と、`?` のゾーンの出方を見て決める
  - 観測(2026-09-27、室内・約 0.7〜2.4 m の場面で 5 秒間): ステータス有効ゾーンの sigma は中央値 10〜11 mm、最大 45〜60 mm。50 mm で落ちるのは 1 フレームに 0〜1 ゾーン程度。当面 50 mm のまま使う(明るい環境・遠距離では未確認)

#### Step 1

- 4x4 の距離が 10 Hz で表示され続けること
  - 確認済み(2026-09-27、ユーザー報告: COM7 で frame 1260 台まで安定して出ていた。ステータスはほぼ 5、近距離で 9)
- ファームウェア転送を 256 バイトずつに分けて書き込んでも、`vl53l8cx_init` のチェックサム確認(`VL53L8CX_STATUS_FW_CHECKSUM_FAIL` = 5)を通ること
  - 確認済み(同上。測距が始まっていることから)
- 起動直後のログ: `sensor alive`、`init done in ... ms`(400 kHz で約 2 秒の見込み)、`I2C1 ... Hz`(399361 Hz の見込み)、`I2C bus recovery` の行
  - 確認済み(2026-09-27): `I2C1 399361 Hz`、`sensor alive`、`init done in 2621 ms`。起動直後の 1 フレーム目はステータス 6 / 13(無効)で、2 フレーム目から 5 になる
- 手をかざすと近くのゾーンの距離が変わること — 確認済み(2026-09-27。センサーの保護テープの有無で目立った差はなかった)
- ゾーンの並びとセンサーの向きの対応 — Step 2 で確定(上記)
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
  bootcamp_config.h       ピン番号、I2C のクロック、解像度・測距の頻度、sigma の上限、表示の既定値などの設定
  depth_view.h            距離画像の表示(ゾーンの有効判定、反転、距離の段階化、sigma の統計、文字列の組み立て)
  i2c_bus_recover.h       I2C バスの復旧(SCL の手動クロックと STOP)
  frame_proto.h           バイナリメッセージの組み立て、CRC-32、COBS(docs/frame-format.md の実装)
  platform.h              ULD のプラットフォーム層(ULD が固定名で include する。出力の有効・無効もここで決める)
  uld_util.h              プラットフォーム層の SDK 非依存の部分(バイト順の入れ替え、分割書き込みのループ、タイムアウト、ステータス判定)
src/
  main.c                  初期化(USB CDC、LPn、I2C バス復旧、I2C1)→ ULD の初期化 → 8x8 の測距結果をポーリングして距離画像を表示、1 文字コマンド
  depth_view.c            depth_view.h の実装(stdint.h / stdbool.h / stddef.h と uld_util.h だけに依存。ホストでテストする)
  frame_proto.c           frame_proto.h の実装(stdint.h / stdbool.h / stddef.h だけに依存。ホストでテストする)
  i2c_bus_recover.c       i2c_bus_recover.h の実装(GPIO でオープンドレインを模して操作)
  platform.c              VL53L8CX_RdByte / WrByte / RdMulti / WrMulti / WaitMs / SwapBuffer / Reset_Sensor の RP2040 実装
  uld_util.c              uld_util.h の実装(stdint.h / stdbool.h だけに依存。ホストでテストする)
tests/
  test_uld_util.c         uld_util の単体テスト(Unity)
  test_depth_view.c       depth_view の単体テスト(Unity)
  test_frame_proto.c      frame_proto の単体テスト(Unity。テストベクタとの一致も検査)
  frame_vectors.h         docs/frame-vectors.json と同じ内容の C の配列(tools/gen_frame_vectors.py が生成。手で編集しない)
  CASES.md                テストの入力と期待値の対応表
docs/
  frame-format.md         バイナリメッセージの形式(版 1)
  frame-vectors.json      形式のテストベクタ(生成物)
tools/
  gen_frame_vectors.py    テストベクタを作る(仕様どおりの参照用エンコーダ。--check で一致だけ確かめる)
  capture_serial.py       USB シリアルをバイナリにして記録する(pyserial)
tools/verification/
  verify_depth_view_expected_values.py  depth_view のテストの期待値の検算
  estimate_ranging_read_time.py         読み出しバイト数と I2C の転送時間の見積もり
  decode_capture.py                     記録のデコードと統計(テストベクタで自己検査する)
web/                      ブラウザアプリ(Vite + TypeScript。node_modules/ と dist/ は git に入れない)
  index.html              入口(画面の要素)
  package.json            依存と npm scripts(package-lock.json も管理する)
  tsconfig.json           型チェックの設定(strict、noUncheckedIndexedAccess)
  vite.config.ts          Vite と Vitest の設定
  eslint.config.js        ESLint(flat config、typescript-eslint)。解析のモジュールから document / window / navigator を使うと失敗する
  .prettierrc.json        Prettier の設定
  src/
    cobs.ts               COBS のエンコード・デコード
    crc32.ts              CRC-32(IEEE)
    frame.ts              ペイロード・パケットの解析と検証(仕様書の拒否条件)
    stream.ts             チャンク → 0x00 区切り → パケット(上限付きバッファ、同期前の読み捨て)
    stats.ts              seq の欠落・後退、拒否の数、受信レート、タイムスタンプの間隔の異常
    receiver.ts           stream + frame + stats をつなぐ受信処理(Web Serial と再生で共通)
    replay.ts             記録ファイルの区間分けと再生のタイミング
    view.ts               向き、ゾーンの有効判定、色、自動レンジ、ゾーンの説明文(DOM 非依存)
    serial.ts             Web Serial の接続・読み取りループ・切断・エラー処理
    render.ts             Canvas 2D の描画(画像と凡例)
    main.ts               画面と状態(グローバルな可変状態はここだけ)、requestAnimationFrame の描画ループ
    style.css             画面のスタイル
  test/
    vectors.ts            docs/frame-vectors.json の読み込みと形の検査
    *.test.ts             Vitest のテスト(cobs / crc32 / frame / stream / stats / replay / view / capture)
    fixtures/
      step3_cap_20260927.bin  実機の記録(2026-09-27、COM7、tools/capture_serial.py で 6 秒、step3 のファームウェア。85886 バイト)
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
- 測距結果の出力は距離・測距ステータス・sigma・ターゲット数だけを有効にしている(`include/platform.h`。Step 3 で signal_per_spad と nb_spads_enabled を追加)。ターゲット数は、ULD がターゲットなしのゾーンのステータスを 255 にするのに使う
- SDA / SCL / INT / LPn の内蔵プルダウン(RP2040 のリセット既定)は外す。プルアップはキャリア基板側にある
- 起動時に I2C バスを復旧してから I2C1 を使い始める(`src/i2c_bus_recover.c`)。測距中に MCU だけがリセットされると、センサーが読み出しの途中で SDA を Low に保持したままになりうる。SDK の I2C 関数はタイムアウトしても abort も STOP もしない(i2c.c)ので、そのままでは is_alive で止まる。SDA / SCL を GPIO にして、SDA が Low の間 SCL を最大 9 回クロックし、SDA が High になったら STOP を出す。手動クロックは約 100 kHz(半周期 5 µs)で、SCL を離した後は最大 1 ms まで High になるのを待つ(クロックストレッチ対策)
- ULD との境界(`VL53L8CX_WaitMs` の `sleep_ms`、`vl53l8cx_init` などの ULD の関数)はブロッキングを許容する。ULD がブロッキングで書かれているため、c-pico-sdk.md の「待ちはブロッキングにしない」の例外とする。メインループのデータ待ちも `sleep_ms` によるポーリング

## 設計メモ(Step 2)

- 解像度 8x8、測距 15 Hz(8x8 の上限)。設定は ULD のとおり `set_resolution` → `set_ranging_frequency_hz` の順
- 1 フレームの読み出しバイト数(ULD の `data_read_size`)は、**Step 2 時点の**有効な出力(距離・ステータス・sigma・ターゲット数)で 8x8 が 452 バイト、4x4 が 164 バイト(`tools/verification/estimate_ranging_read_time.py` と同じ計算。スクリプトは Step 3 で出力を足したので、いまは 972 / 300 バイトを出す。下記「設計メモ(Step 3)」)。I2C の転送は、アドレス等 4 バイト + 452 バイト = 456 バイト × 9 クロック / 399361 Hz = **10.3 ms 以上**(START / STOP と SDK のバイトごとの処理時間は含まない)。15 Hz の周期 66.7 ms の約 15%。データ待ちのポーリング(4 バイト読み)は 1 回 0.18 ms 以上
- ゾーンの有効判定は「ターゲットなし(ターゲット数 0 またはステータス 255)→ ステータスが 5 / 9 以外 → sigma が上限超え」の順。sigma の上限は暫定 50 mm(`BOOTCAMP_SIGMA_MAX_MM`)
- 表示は `src/depth_view.c` でバッファに組み立ててから 1 回で出す。必要なバッファの大きさは `DEPTH_VIEW_RENDER_BUF_SIZE`(3332 バイト = 行数の上限 13 × 1 行の上限 256 + 4)で、それより小さいバッファを渡すと何も書かない。行の上限 256 は、最長の行(8x8 カラーで全ゾーン無効、214 バイト)に余裕を持たせた値で、テストで全行がこれ以下であることを検査している
- 距離画像の文字列は `stdio_put_string`(改行変換あり)で出す。printf の書式処理を通さない
- USB への出力は、ターミナルが開いていない(DTR が立っていない)ときは捨てられる。開いていても読むのが遅い・止まっている場合の動きは「設計メモ(Step 3)」の「ホストが読まないとき」を参照(テキストでもバイナリでも同じ)
- 描画時間(`draw`)の見積もりの前提: USB の送信 FIFO は 64 バイト(SDK の pico_stdio_usb の tusb_config.h の `CFG_TUD_CDC_TX_BUFSIZE`。RP2040 は Full Speed なので 64)。stdio_usb_out_chars は FIFO の空きぶんだけ書いては送信を促す(`tud_task` と `tud_cdc_write_flush`)ことを繰り返すので、1 フレーム(カラーで約 2 KB)は 64 バイト単位で 30 回程度に分けて送られ、ホストが読み取るたびに待つ。実際の値は実機のステータス行で測る
- 1 文字コマンドは `getchar_timeout_us(0)` で読む。文字がなければすぐ戻り、USB 未接続でも止まらない(SDK の stdio.c の stdio_get_until と stdio_usb.c の stdio_usb_in_chars で確認。未接続時は入力元が何も読まずに戻り、期限は呼び出し時刻なので 1 周で抜ける)
- 向きの目印は表示に固定し、反転フラグはゾーンをどこに描くかだけを変える(目印が反転に追従すると、どの反転でも同じ目印の側に同じゾーンが出て、向きを合わせられないため)
- ステータス行・ヘルプ・凡例も `src/depth_view.c` で組み立て、各行が 80 桁以内であることを最長の値(フレーム番号やエラー数が uint32_t の最大、温度 −128、sigma 65535 など)でテストしている。分類ごとのゾーン数だけは 64 以下を前提にした桁数
- フレームレートは、直近 15 フレームの間隔の合計時間から求める(1 フレームの間隔だとポーリング間隔 5 ms ぶん揺れるため)
- キー処理とヘルプ表示の状態(反転・カラー・ヘルプの表示中)は `src/main.c` に置いている。c-pico-sdk.md は状態遷移を SDK 非依存のロジックに分けてテストするよう求めるが、状態が 3 つのフラグとヘルプの期限だけと小さいので例外とする(表示の組み立てと数値の計算は depth_view でテストしている)

## 設計メモ(Step 3)

- 形式は [docs/frame-format.md](docs/frame-format.md) が正。ペイロードは経路に依存せず(将来 XIAO ESP32-C3 で WebSocket / UDP に載せるときも同じペイロード + CRC-32)、USB シリアルだけ COBS で包んで 0x00 で区切る
- signal_per_spad(ブラウザの「IR 画像」)と nb_spads_enabled(ゾーンごとの有効 SPAD 数。signal_per_spad と並べて、受光側の設定がゾーンごとに変わるかを見せる)を有効にした(`VL53L8CX_DISABLE_SIGNAL_PER_SPAD` と `VL53L8CX_DISABLE_NB_SPADS_ENABLED` を外した)。1 フレームの読み出しは 8x8 で 452 → **972 バイト**(signal +260、SPAD 数 +260。`tools/verification/estimate_ranging_read_time.py`)。I2C の転送は (4 + 972) バイト × 9 クロック / 399361 Hz = **22.0 ms 以上**。Step 2 の実測(452 バイトで 12.63 ms、見積もり 10.28 ms の 1.23 倍)と同じ比なら **約 27.0 ms**。15 Hz の周期 66.7 ms の約 40% で、テキストの描画(Step 2 の実測 2〜3 ms)やバイナリの送信を足しても周期に収まる見込み
- ULD の内部バッファ(`temp_buffer`)は 1024 バイトで、有効な出力から決まる最大(`VL53L8CX_MAX_RESULTS_SIZE` = 40 + 260 + 68 + 260 + 132 + 132 + 68 + 20 = 980)より大きいので、972 バイトの読み出しが収まる
- テストベクタは `tools/gen_frame_vectors.py`(Python で書いた参照用のエンコーダ)が `docs/frame-vectors.json` と `tests/frame_vectors.h` に同じ内容で出す。C のテストは同じ入力から C で組み立てたバイト列が一致することを、`tools/verification/decode_capture.py`(別に書いたデコーダ。CRC は zlib)は JSON をデコードして期待値と一致すること・不正なバイト列を理由どおりに拒否することを確かめる。`make test` はベクタが生成スクリプトと一致するかも確かめる
- バイナリは `stdio_put_string(data, len, false, false)` で出す。第 4 引数 `cr_translation` が false なら、SDK は出力先の `out_chars` にそのまま渡す(stdio.c の `stdio_out_chars_no_crlf`。"\n" → "\r\n" の変換は `stdio_out_chars_crlf` の中だけで、`cr_translation` が true のときにしか呼ばれない)。長さを渡すので 0x00 も送れる(len が -1 のときだけ strlen を使う)
- バイナリの出力中は printf を使わない。ログは `log_line()` がモードを見て、テキストなら 1 行、バイナリならログのメッセージ(種別 2)にする
- `b` を受けたら、まず 0x00 を 1 バイト送ってから状態メッセージを送る。受信側は最初の 0x00 までを捨てるので、それまでに届いていたテキスト表示の残りと混ざらない
- 1 フレームは USB 上で最大 923 バイト(ペイロード 914 + CRC 4 を COBS にして最大 922 + 区切り 1)。15 Hz で約 13.8 KB/s。USB の送信 FIFO は 64 バイトなので、1 フレームは 15 回程度に分けて FIFO に書かれる(`stdio_usb_out_chars` が空きの分だけ書いては送信を促すことを繰り返す)
- **ホストが読まないとき**: SDK の stdio_usb_out_chars(stdio_usb.c)は、送信 FIFO に空きがない間は待ち、**最後に FIFO へ書けた時刻**(`last_avail_time`。少しでも書けるたびに更新する)から `PICO_STDIO_USB_STDOUT_TIMEOUT_US`(500 ms)を過ぎたら、そのメッセージの残りを捨てて戻る。待っている間は測距ループも止まる。ホストの状態で結果が分かれる
  - **完全に止まったホスト**(ポートを開いたまま読み取りを止めた): 詰まり始めに **1 回だけ最大 500 ms** 止まる(その間の約 7 フレームはセンサー側で上書きされ、読まれない)。以後は FIFO が空かないので、各メッセージが待たずに捨てられ、測距は続く。読み取りを再開すると、そのとき書き始めたメッセージの途中からが届くことがあり、受信側では COBS / CRC の拒否と seq の欠落として見える
  - **遅いホスト**(読むが約 13.8 KB/s に追いつかない): FIFO に書けるたびに `last_avail_time` が更新されるので捨てられず、FIFO が満杯になるたびに最大 500 ms まで待つ。**測距ループが繰り返し止まり、その間のセンサーのフレームは読まれない**。メッセージが作られないので seq は飛ばない。この取りこぼしは、測距フレームの timestamp の間隔(15 Hz で約 66.7 ms。取りこぼすとその倍数に近くなる)で分かる([docs/frame-format.md](docs/frame-format.md) の「シーケンス番号」「送信側の制約」)
  - ポートを閉じた(DTR が落ちた): SDK は未接続とみなして待たずに捨てるので止まらない
- 状態メッセージの flags はファームウェアの表示の反転(既定 h=1 v=0)。ブラウザ側は描画の反転の初期値に使える

## 設計メモ(Step 3 ブラウザ)

- 解析(`cobs.ts` / `crc32.ts` / `frame.ts` / `stream.ts` / `stats.ts` / `receiver.ts` / `replay.ts` / `view.ts`)は DOM / Web API に依存させず、Vitest で Node 上でテストする。ESLint で document / window / navigator の使用を禁止して境界を守っている
- 失敗は例外ではなく判別可能な値(`{ ok: false, reason }`)で返す。reason は仕様書の「受信側の手順」の語と同じ。区切りが来ないまま上限(2657 バイト)を超えたものは、仕様書の理由にない `overflow` として別に数える
- 受信バッファは上限の大きさ(2657 バイト)の 1 つだけ。上限を超えたら次の 0x00 まで読み捨てる
- ログと状態の文字列は、印字可能な ASCII 以外を `?` に置き換えて持ち、DOM には textContent で入れる(HTML として解釈しない)
- テストは `docs/frame-vectors.json` を `?raw` で読み、形を実行時に確かめてから使う。messages / invalid は同期済みの前提なので先頭に 0x00 を足し、streams は同期前から流す。streams の期待値(leading / trailing / 長さ 0 のパケット / 受け付けた seq / 欠落 / 後退 / 理由別の拒否)は、1 チャンク・全分割位置・1 バイトずつで一致することを確かめる。知らないセクションが増えると todo として表示される
- 描画は requestAnimationFrame で、データが変わったときだけ描く。受信のたびには描かない。統計の欄は 250 ms ごとに更新する
- 自動レンジは、広がるときは即座に、狭まるときは 1 フレームごとに差の 10% ずつ追従する(フレームごとのちらつきを抑える)
- 距離の色は Step 2 と同じ「近 = 暖色 → 遠 = 寒色」だが、8 段階ではなく色相 0〜240° の連続。sigma の上限 50 mm は Step 2 の暫定値に合わせて `view.ts` の定数にしている
- 実機の記録 `test/fixtures/step3_cap_20260927.bin`(2026-09-27、COM7、`tools/capture_serial.py` で 6 秒、step3 のファームウェア)を `capture.test.ts` がデコードする。期待値は `tools/verification/decode_capture.py`(Python の別実装)の出力と同じ: 最初の 0x00 の前に捨てるバイト 2083、状態 1・測距フレーム 91、拒否 0、seq の欠落・後退 0、最大のフレーム間隔 70660 µs。1 チャンク・64 バイトずつ・再生の区間ごとの 3 通りで流す。ワークスペース直下の `.gitignore` が `*.bin` を除外しているので、`web/.gitignore` で `test/fixtures/*.bin` だけ戻している。Vitest では `?inline`(base64 の data URL)で読むため、`vite.config.ts` の `assetsInclude` に `.bin` を入れている
- 再生(`ReplayPlayer`)は、繰り返しの継ぎ目と再生の開始で `onRestart` を呼び、`main.ts` がそこで受信処理と表示をリセットする。予定時刻から 500 ms を超えて遅れたら、溜まった区間を一気に流さず予定を今に合わせる。どちらもフェイクタイマーでテストしている(時計は `now` で差し替える)
- 変異テスト(49 個の変異を 1 つずつ入れて Vitest を実行)で 48 個を検出。残る 1 個(距離を `getUint16` で読む)は、`Int16Array` に入れる時点で符号付きに戻る等価変異。レビュー対応で足した対象: 再生の `onRestart`・繰り返し・遅延の分岐と上限・合わせ直す時刻、`firstTargets` の添字・T の検査・T = 1 の近道
- 画面・Web Serial の部分(`main.ts` の反転の上書きの条件、`serial.ts` の送信の順番・タイムアウト・close の打ち切り)は Vitest の対象外で、ブラウザでの確認項目にしている
