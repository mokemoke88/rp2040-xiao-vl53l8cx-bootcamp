/* SPDX-License-Identifier: MIT */
/**
 * @file uld_util.h
 * @brief VL53L8CX ULD のプラットフォーム層で使う、Pico SDK に依存しない計算(バイト順の入れ替え、分割書き込みの計算、
 *        I2C のタイムアウト、測距ステータスの判定)。
 *
 * stdint.h / stdbool.h だけに依存する。ホストの gcc で単体テストする(tests/test_uld_util.c)。
 */
#ifndef ULD_UTIL_H
#define ULD_UTIL_H

#include <stdbool.h>
#include <stdint.h>

/** @brief VL53L8CX のレジスタアドレスのバイト数。I2C では上位バイトから先に送る。 */
#define ULD_REG_ADDR_BYTES 2u

/**
 * @brief 分割書き込みの1回あたりのデータのバイト数(レジスタアドレスの 2 バイトを含まない)。
 *
 * ファームウェア転送(1 回の VL53L8CX_WrMulti で最大 0x8000 バイト)をこの長さずつに分けて送る。
 * 送信用バッファは ULD_REG_ADDR_BYTES + この値のバイト数になる。
 */
#ifndef ULD_WRITE_CHUNK_BYTES
#define ULD_WRITE_CHUNK_BYTES 256u
#endif

/** @brief I2C 転送のタイムアウトの固定分 [µs]。転送の長さに関係なく足す。 */
#define ULD_I2C_TIMEOUT_BASE_US 10000u

/**
 * @brief I2C 転送のタイムアウトの 1 バイトあたりの分 [µs]。
 *
 * 400 kHz では 1 バイト(8 bit + ACK = 9 クロック)が 22.5 µs。センサーのクロックストレッチなどの余裕を見て
 * 4 倍強にしている。
 */
#define ULD_I2C_TIMEOUT_PER_BYTE_US 100u

/**
 * @brief 4 バイトごとにバイト順を反転する(ULD の VL53L8CX_SwapBuffer の本体)。
 *
 * センサーのデータは 32 bit 単位のビッグエンディアンで並んでいる。ULD はこれをホストの uint32_t として読むために
 * 4 バイトずつ反転させる(同じ呼び出しを 2 回すると元に戻る)。反転はバイト操作で行い、ホストのエンディアンに
 * よらない(RP2040 もテストするホストもリトルエンディアン)。
 * size が 4 の倍数でない場合、末尾の余り(size % 4 バイト)は変更しない。
 * @param buffer 対象のバッファ
 * @param size 対象のバイト数
 */
void uld_swap_buffer(uint8_t *buffer, uint32_t size);

/**
 * @brief 分割書き込みで、offset バイト目から送る塊の長さを返す。
 * @param total 書き込むデータ全体のバイト数
 * @param offset 送り終わったバイト数
 * @param max_chunk 1 回に送るデータの最大バイト数(1 以上)
 * @return min(total - offset, max_chunk)。offset >= total なら 0
 */
uint32_t uld_chunk_len(uint32_t total, uint32_t offset, uint32_t max_chunk);

/**
 * @brief 分割書き込みで、offset バイト目から送る塊の先頭のレジスタアドレスを返す。
 *
 * センサーは書き込みのたびにレジスタアドレスを 1 ずつ進める前提で、塊の先頭アドレスは start_reg + offset になる。
 * 結果は 16 bit に切り詰める(ULD の呼び出しでは 0xFFFF を超えない)。
 * @param start_reg 書き込み全体の先頭のレジスタアドレス
 * @param offset 送り終わったバイト数
 * @return 塊の先頭のレジスタアドレス
 */
uint16_t uld_chunk_reg(uint16_t start_reg, uint32_t offset);

/**
 * @brief I2C で送るバイト列(レジスタアドレスの上位・下位 + データ)を dst に詰める。
 * @param dst 出力先。ULD_REG_ADDR_BYTES + len バイト以上の領域
 * @param reg レジスタアドレス
 * @param data 書き込むデータ(len が 0 なら NULL でもよい)
 * @param len データのバイト数
 * @return dst に書いたバイト数(ULD_REG_ADDR_BYTES + len)
 */
uint32_t uld_pack_write(uint8_t *dst, uint16_t reg, const uint8_t *data, uint32_t len);

/**
 * @brief 分割書き込みで、組み立てた 1 塊(レジスタアドレス + データ)を送る関数の型。
 * @param ctx uld_write_chunked() に渡した ctx がそのまま渡される
 * @param packet 送るバイト列(先頭 ULD_REG_ADDR_BYTES バイトがレジスタアドレス)
 * @param len packet のバイト数
 * @return 全バイト送れたら true
 */
typedef bool (*uld_send_chunk_fn)(void *ctx, const uint8_t *packet, uint32_t len);

/**
 * @brief start_reg から size バイトを、max_chunk バイトずつの塊に分けて送る。
 *
 * 塊ごとに先頭のレジスタアドレス(uld_chunk_reg())を付けたバイト列を buf に組み立て(uld_pack_write())、send に渡す。
 * send が false を返したら、残りの塊は送らずに false を返す。size が 0 なら send を呼ばずに true を返す。
 * @param start_reg 書き込み全体の先頭のレジスタアドレス
 * @param data 書き込むデータ(size バイト)
 * @param size 書き込むバイト数
 * @param buf 組み立て用のバッファ。ULD_REG_ADDR_BYTES + max_chunk バイト以上
 * @param max_chunk 1 塊のデータの最大バイト数。0 なら send を呼ばずに false を返す
 * @param send 1 塊を送る関数
 * @param ctx send に渡す値
 * @return すべての塊を送れたら true
 */
bool uld_write_chunked(uint16_t start_reg, const uint8_t *data, uint32_t size, uint8_t *buf, uint32_t max_chunk,
                       uld_send_chunk_fn send, void *ctx);

/**
 * @brief nbytes バイトの I2C 転送に使うタイムアウト [µs] を返す。
 *
 * ULD_I2C_TIMEOUT_BASE_US + nbytes × ULD_I2C_TIMEOUT_PER_BYTE_US。uint32_t に収まらない場合は UINT32_MAX を返す。
 * @param nbytes 転送するバイト数(アドレスのバイトを含む)
 * @return タイムアウト [µs]
 */
uint32_t uld_i2c_timeout_us(uint32_t nbytes);

/**
 * @brief 測距ステータス(VL53L8CX_ResultsData の target_status)が、距離を有効とみなせる値かを返す。
 *
 * ULD の vl53l8cx_api.h のコメント("5 & 9 means ranging OK")に従い、5 と 9 を有効とする。
 * 255 は ULD が「ターゲットなし」のゾーンに入れる値。
 * @param status 測距ステータス
 * @return 5 または 9 なら true
 */
bool uld_target_status_is_valid(uint8_t status);

#endif // ULD_UTIL_H
