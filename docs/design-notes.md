# 設計メモ

設計の判断と、その根拠になった見積もり・調べたこと。

## 決定事項

- ハードウェアは **本体 2 つのみ**: Seeed Studio XIAO RP2040 + Pololu VL53L8CX キャリア基板。サーボ・ディスプレイ等の追加部品は使わない
- 表示は **PC 側**。マイコンは USB CDC でフレームを送り、**ブラウザ(Web Serial API + three.js)** で可視化する。Web Serial は Chromium 系ブラウザ(Chrome / Edge)が前提
- センサーとの接続は **I2C、クロックは 400 kHz**。ブレッドボードで組むため、センサーとマイコンが対応する 1 MHz(Fast-mode Plus)は使わず控えめにする。帯域が足りなければ 1 MHz や SPI を検討
- ファームウェアは Pico SDK(C)
- センサードライバは ST 公式の ULD(STSW-IMG040 v2.0.1、ドライバ本体 2.0.0、BSD-3-Clause)を `third_party/vl53l8cx_uld/` に置く。出どころと、1 ファイル差し替えた理由は [third_party/vl53l8cx_uld/README.md](../third_party/vl53l8cx_uld/README.md)

## 出力ピンの状態

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
    geometry.ts           ゾーン → 方向の角度 → 3D の位置(垂直距離 / 半径)、ゾーンのパッチ、視野、点群(DOM 非依存。Step 4)
    scene3d.ts            three.js の 3D ビュー(点・パッチ・視野・床・軸・距離の輪。Step 4)
    scan2d.ts             真上からの投影、スキャン線、残像、動きの判定、走査型の模擬(DOM 非依存。Step 5)
    lidarView.ts          LiDAR 風ビュー(真上から見た扇形)の Canvas 2D 描画と、座標変換・最も近い点の選択(Step 5)
    tooltip.ts            ゾーンの値のツールチップの配置(画面端での反転)と文言(DOM 非依存。Step 5)
    demos.ts              デモの一覧(manifest.json)の検証、ビューの ID、URL パラメータ(DOM 非依存。Step 5)
    lecture/text.ts       レクチャー画面と LiDAR 風ビューの解説文(文言だけを集めたもの。Step 5)
    serial.ts             Web Serial の接続・読み取りループ・切断・エラー処理
    render.ts             Canvas 2D の描画(画像と凡例)
    main.ts               画面と状態(グローバルな可変状態はここだけ)、requestAnimationFrame の描画ループ
    style.css             画面のスタイル
  test/
    vectors.ts            docs/frame-vectors.json の読み込みと形の検査
    *.test.ts             Vitest のテスト(cobs / crc32 / frame / stream / stats / replay / view / capture / geometry / scan2d / demos / hover)
    fixtures/
      step3_cap_20260927.bin  実機の記録(2026-09-27、COM7、tools/capture_serial.py で 6 秒、step3 のファームウェア。85886 バイト)
  public/demos/
    manifest.json         デモの一覧(Step 5)
    step3_cap_20260927.bin  仮のデモ(test/fixtures/ と同じ記録。デモ用記録を収録したら差し替える)
third_party/
  vl53l8cx_uld/           ST の VL53L8CX ULD 2.0.0(BSD-3-Clause。改変しない)
  unity/                  Unity(MIT)
```

### エディタ(clangd)

リポジトリ直下の `.clangd` が `build/compile_commands.json`(`make firmware` で生成)を参照する。arm-none-eabi-gcc の標準ヘッダを clangd に見つけさせるには、エディタ側で clangd の起動引数に `--query-driver=<arm-none-eabi-gcc のパス>*` を追加する。`tests/` はコンパイル DB に含まれないため、`.clangd` で Unity のインクルードパスを足している。

## 設計メモ(Step 1)

- ULD の I2C アドレスは 8 bit 表記(0x52)のまま `VL53L8CX_Platform.address` に持ち、Pico SDK に渡すときだけ 1 bit 右シフトする
- 読み出しは「レジスタアドレスを nostop で書く → RESTART → 読む」の 1 トランザクション。書き込みはレジスタアドレスとデータを 1 回の書き込みにまとめる(Pico SDK は nostop の次の書き込みの最初のバイトに RESTART ビットを立てるため。ビットを立てることは SDK のソースで確認、バス上の波形は未確認)。ファームウェア転送(1 回 0x8000 バイト)に備えて 256 バイトずつに分割し、塊ごとにレジスタアドレスを付け直して送る(`uld_write_chunked`。途中の塊が失敗したら残りは送らない)。センサーのアドレス自動インクリメントが前提で、ファームウェア転送が通ったことを実機で確認した。通らなくなった場合の代替は 0x8000 + 2 バイトの静的バッファで 1 トランザクションにすること(RAM 264 KB に対して 32 KB)
- SDK の `i2c_write_burst_blocking`(RESTART を付けずに続けて書ける)は、タイムアウト付きの版がないので使わない
- I2C 関数はタイムアウト付き(`i2c_*_timeout_us`)を使う。タイムアウトは 10 ms + 転送バイト数 × 100 µs。失敗したら ULD には 255 を返し、SDK の戻り値を `last_i2c_error` に残す
- 測距結果の出力は距離・測距ステータス・sigma・ターゲット数だけを有効にしている(`include/platform.h`。Step 3 で signal_per_spad と nb_spads_enabled を追加)。ターゲット数は、ULD がターゲットなしのゾーンのステータスを 255 にするのに使う
- SDA / SCL / INT / LPn の内蔵プルダウン(RP2040 のリセット既定)は外す。プルアップはキャリア基板側にある
- 起動時に I2C バスを復旧してから I2C1 を使い始める(`src/i2c_bus_recover.c`)。測距中に MCU だけがリセットされると、センサーが読み出しの途中で SDA を Low に保持したままになりうる。SDK の I2C 関数はタイムアウトしても abort も STOP もしない(i2c.c)ので、そのままでは is_alive で止まる。SDA / SCL を GPIO にして、SDA が Low の間 SCL を最大 9 回クロックし、SDA が High になったら STOP を出す。手動クロックは約 100 kHz(半周期 5 µs)で、SCL を離した後は最大 1 ms まで High になるのを待つ(クロックストレッチ対策)
- ULD との境界(`VL53L8CX_WaitMs` の `sleep_ms`、`vl53l8cx_init` などの ULD の関数)はブロッキングを許容する。ULD がブロッキングで書かれているため、「待ちはブロッキングにしない」という方針の例外とする。メインループのデータ待ちも `sleep_ms` によるポーリング

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
- キー処理とヘルプ表示の状態(反転・カラー・ヘルプの表示中)は `src/main.c` に置いている。状態遷移は SDK 非依存のロジックに分けてテストする方針だが、状態が 3 つのフラグとヘルプの期限だけと小さいので例外とする(表示の組み立てと数値の計算は depth_view でテストしている)

## 設計メモ(Step 3)

- 形式は [frame-format.md](frame-format.md) が正。ペイロードは経路に依存せず(将来 XIAO ESP32-C3 で WebSocket / UDP に載せるときも同じペイロード + CRC-32)、USB シリアルだけ COBS で包んで 0x00 で区切る
- signal_per_spad(ブラウザの「IR 画像」)と nb_spads_enabled(ゾーンごとの有効 SPAD 数。signal_per_spad と並べて、受光側の設定がゾーンごとに変わるかを見せる)を有効にした(`VL53L8CX_DISABLE_SIGNAL_PER_SPAD` と `VL53L8CX_DISABLE_NB_SPADS_ENABLED` を外した)。1 フレームの読み出しは 8x8 で 452 → **972 バイト**(signal +260、SPAD 数 +260。`tools/verification/estimate_ranging_read_time.py`)。I2C の転送は (4 + 972) バイト × 9 クロック / 399361 Hz = **22.0 ms 以上**。Step 2 の実測(452 バイトで 12.63 ms、見積もり 10.28 ms の 1.23 倍)と同じ比なら **約 27.0 ms**。15 Hz の周期 66.7 ms の約 40% で、テキストの描画(Step 2 の実測 2〜3 ms)やバイナリの送信を足しても周期に収まる見込み
- ULD の内部バッファ(`temp_buffer`)は 1024 バイトで、有効な出力から決まる最大(`VL53L8CX_MAX_RESULTS_SIZE` = 40 + 260 + 68 + 260 + 132 + 132 + 68 + 20 = 980)より大きいので、972 バイトの読み出しが収まる
- テストベクタは `tools/gen_frame_vectors.py`(Python で書いた参照用のエンコーダ)が `docs/frame-vectors.json` と `tests/frame_vectors.h` に同じ内容で出す。C のテストは同じ入力から C で組み立てたバイト列が一致することを、`tools/verification/decode_capture.py`(別に書いたデコーダ。CRC は zlib)は JSON をデコードして期待値と一致すること・不正なバイト列を理由どおりに拒否することを確かめる。`make test` はベクタが生成スクリプトと一致するかも確かめる
- バイナリは `stdio_put_string(data, len, false, false)` で出す。第 4 引数 `cr_translation` が false なら、SDK は出力先の `out_chars` にそのまま渡す(stdio.c の `stdio_out_chars_no_crlf`。"\n" → "\r\n" の変換は `stdio_out_chars_crlf` の中だけで、`cr_translation` が true のときにしか呼ばれない)。長さを渡すので 0x00 も送れる(len が -1 のときだけ strlen を使う)
- バイナリの出力中は printf を使わない。ログは `log_line()` がモードを見て、テキストなら 1 行、バイナリならログのメッセージ(種別 2)にする
- `b` を受けたら、まず 0x00 を 1 バイト送ってから状態メッセージを送る。受信側は最初の 0x00 までを捨てるので、それまでに届いていたテキスト表示の残りと混ざらない
- 1 フレームは USB 上で最大 923 バイト(ペイロード 914 + CRC 4 を COBS にして最大 922 + 区切り 1)。15 Hz で約 13.8 KB/s。USB の送信 FIFO は 64 バイトなので、1 フレームは 15 回程度に分けて FIFO に書かれる(`stdio_usb_out_chars` が空きの分だけ書いては送信を促すことを繰り返す)
- **ホストが読まないとき**: SDK の stdio_usb_out_chars(stdio_usb.c)は、送信 FIFO に空きがない間は待ち、**最後に FIFO へ書けた時刻**(`last_avail_time`。少しでも書けるたびに更新する)から `PICO_STDIO_USB_STDOUT_TIMEOUT_US`(500 ms)を過ぎたら、そのメッセージの残りを捨てて戻る。待っている間は測距ループも止まる。ホストの状態で結果が分かれる
  - **完全に止まったホスト**(ポートを開いたまま読み取りを止めた): 詰まり始めに **1 回だけ最大 500 ms** 止まる(その間の約 7 フレームはセンサー側で上書きされ、読まれない)。以後は FIFO が空かないので、各メッセージが待たずに捨てられ、測距は続く。読み取りを再開すると、そのとき書き始めたメッセージの途中からが届くことがあり、受信側では COBS / CRC の拒否と seq の欠落として見える
  - **遅いホスト**(読むが約 13.8 KB/s に追いつかない): FIFO に書けるたびに `last_avail_time` が更新されるので捨てられず、FIFO が満杯になるたびに最大 500 ms まで待つ。**測距ループが繰り返し止まり、その間のセンサーのフレームは読まれない**。メッセージが作られないので seq は飛ばない。この取りこぼしは、測距フレームの timestamp の間隔(15 Hz で約 66.7 ms。取りこぼすとその倍数に近くなる)で分かる([frame-format.md](frame-format.md) の「シーケンス番号」「送信側の制約」)
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
- 実機の記録 `test/fixtures/step3_cap_20260927.bin`(2026-09-27、COM7、`tools/capture_serial.py` で 6 秒、step3 のファームウェア)を `capture.test.ts` がデコードする。期待値は `tools/verification/decode_capture.py`(Python の別実装)の出力と同じ: 最初の 0x00 の前に捨てるバイト 2083、状態 1・測距フレーム 91、拒否 0、seq の欠落・後退 0、最大のフレーム間隔 70660 µs。1 チャンク・64 バイトずつ・再生の区間ごとの 3 通りで流す。リポジトリ直下の `.gitignore` が `*.bin` を除外しているので、`web/.gitignore` で `test/fixtures/*.bin` だけ戻している。Vitest では `?inline`(base64 の data URL)で読むため、`vite.config.ts` の `assetsInclude` に `.bin` を入れている
- 再生(`ReplayPlayer`)は、繰り返しの継ぎ目と再生の開始で `onRestart` を呼び、`main.ts` がそこで受信処理と表示をリセットする。予定時刻から 500 ms を超えて遅れたら、溜まった区間を一気に流さず予定を今に合わせる。どちらもフェイクタイマーでテストしている(時計は `now` で差し替える)
- 変異テスト(49 個の変異を 1 つずつ入れて Vitest を実行)で 48 個を検出。残る 1 個(距離を `getUint16` で読む)は、`Int16Array` に入れる時点で符号付きに戻る等価変異。レビュー対応で足した対象: 再生の `onRestart`・繰り返し・遅延の分岐と上限・合わせ直す時刻、`firstTargets` の添字・T の検査・T = 1 の近道
- 画面・Web Serial の部分(`main.ts` の反転の上書きの条件、`serial.ts` の送信の順番・タイムアウト・close の打ち切り)は Vitest の対象外で、ブラウザでの確認項目にしている

## 設計メモ(Step 4)

- ファームウェアとフレーム形式は変えていない(ブラウザ側だけの Step)
- **座標系**: `geometry.ts` はセンサー座標(x = センサーから見て右、y = 上、z = 前方。mm)で計算する。この 3 軸は左手系(x × y が −z)。three.js は右手系なので、`geometry.ts` の `sensorToWorld`(DOM 非依存。`scene3d.ts` が使う)で (x, y, −z) / 1000 に写して前方を −z にしている。これは基底の取り替え(前方を −z と呼び直す)で鏡像にはならない(レビューで確認)。写像の符号はテストで固定し、z の反転を外す・x や y の符号を変える変異が検出されることを確かめた。そのまま入れると、センサーの後ろから見たときに左右が鏡像になる(右へ動かした手が左へ動いて見える)
- **向き**: ゾーン → 正面から見た図の行・列は `view.ts` の `zoneAt` の逆(`zoneGridPosition`)。正面から見た図の列が右へ進むほど、センサーから見ると左(角度が負)。状態メッセージの flags 0〜3 と zone 0 の象限の対応をテストで固定している(h=1 v=0 で zone 0 はセンサーから見て左上)
- **方向と位置**: 方向ベクトルは (tan θx, tan θy, 1) に比例。垂直距離は z = d、x = d·tan θx、y = d·tan θy。半径はこの方向の単位ベクトル × d。同じ d で z の比が、軸からの角度の cos になる
- **パッチ**: ゾーン中心の角度 ± ピッチ / 2 の 4 方向を同じ解釈・同じ距離で置いた四角形。隣のゾーンと角度の境界を共有するので、同じ距離なら隅が一致する(テストで 4x4 / 8x8・4 通りの反転・2 つの解釈について検査)
- **描画**: 点・パッチ・無効の点・無効のパッチの 4 つの BufferGeometry を最大 64 ゾーンぶん最初に確保し、属性の値だけを書き換えて drawRange で数を変える。頂点を毎回書き換えるので視錐台カリングは切っている。頂点色は sRGB から線形に直して入れる(2D と同じ見た目の色にするため)。OrbitControls の change で描画の要求を立て、requestAnimationFrame の中で必要なときだけ描く
- **テスト**: `test/geometry.test.ts`。ピッチ、隅の角度、中央の 4 ゾーンの対称、隣との間隔、`zoneAt` との逆関係(全ゾーン・4 通りの反転・4x4 / 8x8)、状態の flags と zone 0 の象限、垂直 / 半径の関係(z の比が cos、隅のゾーンの中心で約 1.121 倍・視野の隅で約 1.159 倍、平らな壁が垂直距離でだけ z 一定)、このモデルの対角が約 60.7° であること、センサー座標 → three.js の世界座標の写像(右 = +x、上 = +y、前方 = −z、右 × 上 = −前方で右手系)、パッチが隣と接すること、視野の隅との一致、点群(距離 0 以下を除く、T = 2 で最初のターゲット)、実機の記録(91 フレームすべてで有効ゾーン 60 以上、有効な点が視野の中・4 m の範囲、2 つの解釈で距離が保たれる)
- **変異テスト**(Step 4 分): `geometry.ts` と `view.ts` の `zoneValueColor` に 26 個の変異を入れ、すべて検出(画角・ピッチ・ゾーンの範囲検査・反転・角度の中点と符号と転置・度からラジアン・垂直 / 半径の式・パッチの幅と隅の順・視野の広さ・点群の距離 0 の扱いとターゲットの添字と解釈と有効判定・色の値と添字)。最初は `zoneValueColor` の添字(ターゲットごと / ゾーンごと)の変異 2 個が生き残ったので、T = 2 のテストを足した
- three.js の描画そのもの(`scene3d.ts`)は単体テストしていない。ブラウザで確認する

- **初期の視点**(2026-09-28 に変更): 近距離(1 m 未満)で見ることが多く、0〜4 m 全体を収める視点(カメラ (0.9, 0.8, 1.3) m → 注視点 (0, 0, −1.2) m)では手前の点が小さく固まって読み取りにくかったので、カメラ (0.35, 0.3, 0.4) m → 注視点 (0, 0, −0.5) m(世界座標、前方は −z)にした。目安として、視野の四角錐の 1 m の断面と、1 m までの 0.1 m ごとの輪(0.5 m ごとの輪より暗い色)を足した。見え方は headless の Chrome で `?view=3d&demo=step3-sample` のスクリーンショットで確かめた
- **全ターゲットの描画**(2026-09-28、ファームの既定を 1 ゾーン 2 ターゲット / closest にした後に追加): 3D だけ、各ゾーンで検出したターゲットをすべて描く(`buildPointCloud` の `"detected"`)。ほかの図は最初のターゲットのまま(`"first"`。LiDAR 風ビューの `projectTop` もこちら)。切り替えの UI と、2 つ目以降の見た目の区別は設けない(ユーザーの判断。距離の色で分かる)。ゾーンごとに t = 0 から max(1, min(T, nb_target_detected)) 個を候補にする。t = 0 を常に候補にするのは、`"first"` と同じく「ターゲットなし」のゾーンも無効の点として返すため(「無効ゾーンも表示」の見え方を変えない)。min(T, …) は、検出数が T を超えた値でも次のゾーンの値を読まないため。有効・無効は `classifyTarget`(ターゲットごと。検出数を超えるターゲットは none)、色は `zoneValueColor` の target 引数。BufferGeometry は 64 ゾーン × 4 ターゲット(形式の T の上限、`MAX_TARGETS_PER_ZONE`)= 256 点ぶんを確保する。T = 1 の記録では `"detected"` と `"first"` が同じ点群になることをテストで確かめている
- **変異テスト**(全ターゲットの描画): `view.ts`(`classifyTarget` の境界と添字、`classifyZone` の target、`zoneValueColor` の添字と SPAD 数の添字)と `geometry.ts`(max(1)、min(T)、検出数がないときの既定、`"first"` の数、距離の添字、cls と target の値、距離 0 以下の除外)に 14 個の変異を入れ、すべて検出。最初は「SPAD 数の添字にターゲットを足す」変異が生き残った(テストのゾーンと隣のゾーンの SPAD 数が同じ値だった)ので、値の変わる境目のゾーンで確かめるように直した。`scene3d.ts` の描画そのものは単体テストしていない

## 設計メモ(Step 5)

- ファームウェアとフレーム形式は変えていない(ブラウザ側と記録ファイルだけの Step)
- **計算と描画の分離**: `scan2d.ts`(DOM 非依存。ESLint で DOM の使用を禁止)に、真上からの投影(`projectTop`。geometry.ts の点群を使う)、スキャン線(`scanLine`)、残像(`ScanHistory`)、動きの判定(`MotionDetector`)、走査型の模擬(`ScanSimulator`)を置いた。描画は `lidarView.ts`(Canvas 2D)。有効判定は view.ts の `classifyZone`(ステータス・sigma の上限)をそのまま使う
- **センサーから見た列**: 正面から見た図(2D 画像)の列とは左右が逆(`sensorColumn` = side − 1 − 正面から見た列)。スキャン線はセンサーから見て左端の列から並べ、水平の角度は geometry.ts の `zoneAnglesDeg`(角度で等間隔の仮定)
- **動きの判定の sigma**: しきい値は max(100 mm, 3 × sigma)。sigma が 50 mm を超えるゾーンはそもそも無効なので、倍率が 2 だと 2 × 50 = 100 でしきい値を超えられず sigma が効かない。3 にして sigma 34 mm 以上でしきい値が上がるようにした。値は暫定
- **走査型の模擬**: 直近 side フレームをためて、センサーから見た列 k を k 番目に古いフレームから取る。解像度・ターゲット数・field_mask が変わったら、ためたフレームを捨てる。向き(h / v)を変えたときも捨てる(列の対応が変わるため)
- **描画の頻度**: LiDAR 風ビューは、残像が残っている間と演出を出している間だけ毎フレーム描き、それ以外はデータか設定が変わったときだけ。プレゼンの表示では、出ていないビュー(LiDAR 風・2D 画像・3D・レクチャー)は描かない。描き直しの要求(dirty)は残しておき、そのビューが出たときに描く
- **全画面**: `document.documentElement` を Fullscreen API で全画面にし、`body.presenting` の CSS で選んだビューだけを出す。ビューの切り替えは CSS のクラスだけなので、全画面を出入りしない(requestFullscreen はユーザー操作の中でしか呼べないため、URL パラメータで開いたときは CSS だけの表示にして、`F` で全画面にする)。canvas は `layout()` が画面の大きさから決め直す(2D 画像は描画の座標を 320 基準のまま ctx の変換で拡大する。`setupCanvas` に倍率を足した)。3D は `Scene3D.resize`
- **キー操作**: テキスト入力・select・textarea・contentEditable にフォーカスがあるとき、Ctrl / Alt / Meta と一緒のとき、IME の変換中、押しっぱなしの繰り返し(`e.repeat`)は無視する。requestFullscreen の完了を待つ間は、もう一度要求しない
- **画面の倍率**: devicePixelRatio の変化(別の倍率のモニタへ移す、ブラウザの拡大率を変える)を `matchMedia("(resolution: …dppx)")` の変化で拾い、canvas と 3D(`setPixelRatio`)を描き直す
- **動きの判定の「空」**: ターゲットなしのゾーンに物が入ったときにも検出するため、背景に「まだ見ていない / 空 / 距離」の 3 つの状態を持たせた。空からの出現は差によらず「動いた」とし、背景は最大測距距離(4 m)から追従させる(その後も背景が追いつくまで強調が続く)。距離に一気に合わせると 1 フレーム(約 67 ms)しか強調されず見えないため
- **デモの一覧**: `demos.ts`(DOM 非依存)で `manifest.json` を実行時に検査する(版、`id` の形と重複、`file` はディレクトリを含まない `.bin` のファイル名だけにして `public/demos/` の外を指せないようにする、`title`・`seconds`・`view`)。書いたファイルが実際にあるかは Vitest で `import.meta.glob` を使って `public/demos/` と突き合わせる(アプリは取得の失敗をログに出す)
- **レクチャーの文言**: `web/src/lecture/text.ts` に集めた。画面の文字はすべて textContent で入れる
- **テスト**: `test/scan2d.test.ts`(投影、列の並び、行の帯、最近距離・無効ゾーン・距離 0 以下の除外、残像の不透明度と 1.5 秒ちょうどで消えること、動きのしきい値の境界・sigma・背景の追従・無効ゾーン・解像度の変化、模擬の列ごとのフレーム・向き・たまるまで null・解像度 / T / field_mask の変化・T = 2 の配列、演出の角度、実機の記録: 91 フレームすべてで中央 2 行の 8 方向に有効な距離、全行の最近距離は中央 2 行以下、動いたゾーンは 1 フレームで 10 以下(記録では最大 6)、8 フレーム目から模擬の出力)、`test/demos.test.ts`(同梱の manifest が正しくファイルがあること、形の誤り 17 通り、重複、URL パラメータ)。レビュー対応で、残像が add だけで上限を超えないこと、期限切れを add でも捨てること、空の背景(空 → 有効で検出、背景の追従の長さ、去ったら空に戻って再検出、ターゲット数 0 も空、ステータス無効は空にしない)、scanLine と MotionDetector の T = 2(ターゲット 0 の距離・ステータス・sigma を使う)、T の変化での背景の作り直しを足した
- **変異テスト**(Step 5 分): `scan2d.ts`・`demos.ts`・`lidarView.ts` の `sweepAngleDeg` に 34 個の変異を入れ、すべて検出。最初は「T が変わったときの模擬のリセット」の変異が生き残った(T だけを変えるテストがなかった)ので、テストを足した。レビュー対応の後に、残像の上限・空の背景・T の添字など 18 個を追加で入れ、すべて検出
- **ブラウザでの確認(こちらで行った範囲)**: `npm run build` + `npm run preview` を headless の Chrome で開き、`?view=lidar` / `lectureA` / `lectureB` / `lectureC` / `images` / `3d` と `?demo=step3-sample` の画面のスクリーンショットで、描画と全画面のレイアウト(CSS だけの表示)を確かめた。このとき、URL でビューを指定してもデモの推奨ビューに切り替わってしまう不具合と、LiDAR 風ビューの目盛りの文字の重なりを見つけて直した。Fullscreen API・キー操作・実機での見え方は確かめていない
- **ゾーンの値のツールチップ**(実機で使ってみて追加。以前は画像にマウスを乗せると下の「ゾーン」の欄に値を出していたが、欄がページの下にあり、乗せたまま見られなかった): `position: fixed` の要素をカーソルのそばに出す。マウスの状態は「どの図の、描画の座標でどこか」だけを持ち、ゾーンは描画のたびに現在の向き・データ・図の大きさから求め直す(8x8 画像は `cellFromPoint`、扇形は `lidarView.ts` の `pickNearestPoint`)。配置(`placeTooltip`)・最も近い点・模擬の何フレーム前か(`scanLagFrames`、`ScanSimulator.sourceSeqs`)は DOM 非依存で、`test/hover.test.ts` でテストしている。変異 19 個をすべて検出(当たり判定の半径の境界・同じ距離のとき・無効な点と範囲外の点・画面の左右、ツールチップの反転の境界・端の余白・反転後の間隔・縦横の取り違え、何フレーム前の向き、元のフレームの seq の並び、デバイスの消失の判定)。最初は当たり判定の半径の値の変異が生き残った(テストが定数を名前で参照していた)ので、画面の説明と同じ 12 px であることを検査した
- **USB の抜去のログ**: 抜去で読み取りが NetworkError になったときは、読み取りエラーの警告を出さず、切断の 1 行(INFO、「デバイスが外れた(USB の抜去など)」)だけにした。接続が続く読み取りエラー(readable が差し替わる)は従来どおり WARN で出して読み続け、続けられないほかのエラーは切断の 1 行(WARN)にまとめる。ポートの `disconnect` イベントでのログはやめた(切断の行と重なるため)

## 設計メモ(測距の設定)

- **測距モードを明示する**: Step 1〜5 では解像度と頻度しか設定しておらず、ULD の既定値(autonomous、積分時間 5 ms。UM3109 Rev 12、ULD の `vl53l8cx_api.h` の "The default mode is Autonomous")で動いていた。既定値に頼らず、`vl53l8cx_set_ranging_mode` と `vl53l8cx_set_integration_time_ms` で同じ値を明示的に設定する(動作は変えない)。設定は `vl53l8cx_set_ranging_frequency_hz` の後、`vl53l8cx_start_ranging` の前(get / set は測距中は使えない)
- **読み返して出す**: 設定の後に、測距モード・積分時間・sharpener・ターゲットの順をセンサーから読み返し、起動ログの 1 行(`sensor: mode autonomous, integration 5 ms, sharpener N%, order strongest`)にする。sharpener の既定値は資料で食い違う(UM3109 Rev 12 は 1%、データシート DS14161 Rev 12 の画角の測定条件は「14%(既定値)」)ので、実際の値を出して確かめられるようにした。sharpener は変えない(ターゲットの順は下記「設計メモ(1 ゾーン 2 ターゲット)」のオプションで設定する。既定は closest)
- **ブラウザへはログのメッセージで送る**: 状態メッセージ(種別 3)に設定のフィールドを足すと、フレーム形式の版を上げることになり、テストベクタと 3 つの実装(C / Python / TypeScript)、既存の記録ファイルの扱いまで変わる。見合わないので、バイナリに入った直後(状態メッセージの後)に同じ 1 行をログのメッセージ(種別 2、INFO)で送る。形式は版 1 のまま
- **切り替え**: CMake のオプションで変えられる(既定は autonomous / 5 ms)。`make firmware BUILD_DIR=build-continuous CMAKE_ARGS=-DBOOTCAMP_RANGING_CONTINUOUS=ON` で continuous、`CMAKE_ARGS=-DBOOTCAMP_INTEGRATION_TIME_MS=15` で積分時間を変える。積分時間は 2〜1000 ms(ULD のコメント)。8x8 の autonomous は 4 回の積分からなり「合計 + 1 ms」が周期を超えると周期が延びる(UM3109)ので、8x8 / 15 Hz で 16 ms を超える値はビルドで弾く(`_Static_assert`。4x4 の積分の回数は資料で確かめていないので 8x8 だけ)。continuous と autonomous の性能の比較は未実施
- **ファームウェアの版**: `CMakeLists.txt` の `project(VERSION)` を compile definition で渡し、`xiao-vl53l8cx-bootcamp 1.0.0 (ULD VL53L8CX_2.0.0)` にする。手で上げる。状態メッセージの版の文字列は 64 バイトまでで、固定の部分が 44 バイトあるので、版に使えるのは 20 バイトまで。`git describe` の形(例 `v1.0.0-3-g3a9813e-dirty`、23 バイト)は収まらないので使わない。超えたらビルドで弾く(`_Static_assert`)。テストベクタと `test/fixtures/` の記録にある `step3` の文字列は、例のデータと当時の記録なので変えない

## 設計メモ(1 ゾーン 2 ターゲット)

- **切り替え**: 1 ゾーンあたりのターゲット数(ULD の `VL53L8CX_NB_TARGET_PER_ZONE`)は CMake のキャッシュ変数 `BOOTCAMP_TARGETS_PER_ZONE`(1〜4、**既定 2**。2026-09-28 に 1 から変更)で変える。例: `make firmware BUILD_DIR=build-t1 CMAKE_ARGS=-DBOOTCAMP_TARGETS_PER_ZONE=1`。ULD のソースも同じ値で配列の大きさと出力の形式を決めるので、compile definition はターゲット全体に付ける(`include/platform.h` は `#ifndef` で CMake と同じ既定 2 を持つ)。キャッシュ変数なので、既にある build ディレクトリでは前の値が残る(既定を変えた後は `CMAKE_ARGS` で明示するか、ディレクトリを作り直す)
- **見積もり(8x8、T = 2)**: 1 フレームの読み出しは 972 → **1548 バイト**(signal_per_spad +256、sigma +128、距離 +128、ステータス +64。ターゲット数と SPAD 数はゾーンごとなので変わらない。`tools/verification/estimate_ranging_read_time.py --targets 2`。T > 1 ではブロックヘッダの idx も変わる)。I2C の転送は **35.0 ms 以上**、Step 2 の実測との比(×1.229)で **約 43.0 ms**。15 Hz の周期 66.7 ms の約 65%。ULD の一時バッファは `VL53L8CX_MAX_RESULTS_SIZE` = 1556 バイトになり、1548 バイトが収まる
- **USB**: バイナリの 1 フレームはペイロード 1490 バイト(ヘッダ 18 + 距離 256 + ステータス 128 + sigma 256 + ターゲット数 64 + signal 512 + SPAD 数 256)。15 Hz で約 23 KB/s。送信にかかる時間は見積もっていない(実機で測る)
- **テキスト表示**: depth_view はゾーン番号で並んだ配列を受け取るので、`draw_frame` で最初のターゲット(センサーのターゲットの順で先頭)の距離・ステータス・sigma をゾーン番号の配列に写してから渡す。T = 1 のときは写さない。depth_view 本体は変えない
- **既定を T = 2 / closest にした理由**(2026-09-28): 手前の対象 1 つと奥の壁を同じゾーンで捉えたいため。T = 2 で 8x8 / 15 Hz を保てること(read 42.8 ms)と、closest で先頭が常に手前になることを実機で確かめてから既定にした。T = 1 のときに比べ、物の縁のゾーンでは表示される距離が「強いほう」から「近いほう」に変わる
- **ターゲットの順**: T = 2(strongest)で手をかざした場面では、2 つとも有効な 309 件のうち、先頭が手前だったのは 205 件、奥の壁が先頭だったのは 104 件(2026-09-28、実機)。表示は先頭を描くので、物の縁のゾーンに奥の距離が出る。CMake のオプション `BOOTCAMP_TARGET_ORDER_CLOSEST`(**既定 ON**。2026-09-28 に OFF から変更)で closest にし、`configure_ranging` が `vl53l8cx_set_target_order` で設定して読み返す(`sensor: ... order closest`)。closest では 2 つとも有効な 385 件すべてで先頭が手前だった。ULD の既定(1 ターゲット、strongest)に戻すビルドは `make firmware BUILD_DIR=build-t1 CMAKE_ARGS="-DBOOTCAMP_TARGETS_PER_ZONE=1 -DBOOTCAMP_TARGET_ORDER_CLOSEST=OFF"`
- **バイナリとブラウザ**: フレーム形式は T = 1〜4 に対応済みで、ファームは ULD の配列をそのまま送る。ブラウザの画像・3D・LiDAR 風ビューは最初のターゲット、ツールチップは全ターゲットを出す(Step 3〜5 の実装)

## 今後の候補(未着手)

- **デモ用記録の収録**(保留): 手を左右に振る、人が前を横切る、白い物と黒い物、正面の壁。手順は [usage.md](usage.md) の「最終デモ(Step 5)」の「デモ(実機なし)」
- **XIAO ESP32-C3 での無線化**: ケーブルから離して動かせるように(2026-09-27 の会話で出た案)。フレーム形式は経路非依存にしてあるので、プラットフォーム層(I2C)を ESP-IDF に移し、WebSocket / UDP でペイロード + CRC を送れば、ブラウザ側は受信の入口を足すだけで済む見込み
