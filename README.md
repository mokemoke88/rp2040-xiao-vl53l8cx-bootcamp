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
| 1. 測距 | ULD ドライバを移植し、4x4 の距離を USB シリアルに printf | 配線、I2C、ULD のプラットフォーム層、センサーへのファームウェア転送 | 未着手 |
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

ビルド・書き込み手順は Step 1 の実装時に追記する。
