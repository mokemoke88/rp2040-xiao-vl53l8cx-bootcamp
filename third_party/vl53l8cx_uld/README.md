# VL53L8CX ULD(ST 公式ドライバ)

ST の VL53L8CX Ultra Lite Driver。このディレクトリのファイルは整形・改変しない(下記の差し替えを除く)。

## 出どころ

- パッケージ: STSW-IMG040 v2.0.1(2025-02-17)。st.com からダウンロード(2026-09-27)
  - アーカイブ `STSW-IMG040.zip` の SHA-256: `96f7352dab02a49bf5945a479559a1a691666802f3ae13e4d013e2c0de10f851`
- ドライバ本体の版: `VL53L8CX_API_REVISION` = `VL53L8CX_2.0.0`(v2.0.1 の変更はサンプルのみ。`changelog.txt` 参照)
- ライセンス: BSD-3-Clause(`LICENSE.txt`)

## 取り込んだもの

| ここ | アーカイブ内 |
|---|---|
| `inc/`、`LICENSE.txt` | `VL53L8CX_ULD_driver_2.0.1/VL53L8CX_ULD_API/` |
| `src/`(`vl53l8cx_api.c` 以外) | 同上 |
| `src/vl53l8cx_api.c` | `VL53L8CX_ULD_driver_2.0.1/CubeIDE_F401RE_Example_I2C/Drivers/BSP/Components/VL53L8CX_ULD_API/src/vl53l8cx_api.c`(**差し替え**) |
| `changelog.txt` | `VL53L8CX_ULD_driver_2.0.1/changelog.txt` |

**`vl53l8cx_api.c` を差し替えた理由**: アーカイブ直下の `VL53L8CX_ULD_API/src/vl53l8cx_api.c` は 368 行目(ファームウェアのチェックサム不一致時)が `goto exit` でセミコロンが抜けており、コンパイルできない。同じアーカイブの CubeIDE サンプル同梱版はこの 1 文字だけが異なり、ST の GitHub(`STMicroelectronics/x-cube-tof1` の `Drivers/BSP/Components/vl53l8cx/modules/`)の版とも一致する。ほかのファイルはアーカイブ直下と GitHub 版で同一。

プラットフォーム層(`VL53L8CX_RdByte` / `WrByte` / `RdMulti` / `WrMulti` / `WaitMs` / `SwapBuffer` / `Reset_Sensor`)はパッケージのひな形を使わず、ワークスペース側で RP2040 向けに実装する。
