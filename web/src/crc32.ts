/**
 * CRC-32(IEEE 802.3 / ISO-HDLC。zlib の crc32 と同じ)。
 * 仕様: docs/frame-format.md の「CRC-32」。
 */

/** 反転した表現の多項式(0x04C11DB7 のビット順を逆にしたもの) */
const POLY_REFLECTED = 0xedb88320;

/** 1 バイトぶんの剰余の表(256 要素) */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ POLY_REFLECTED : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * バイト列の CRC-32 を計算する。
 *
 * @param data - 対象のバイト列(空でもよい。空の CRC は 0)
 * @returns CRC-32 の値(0〜0xFFFFFFFF の符号なし整数)
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    // TABLE は 256 要素で、添字は 0〜255 に収まる
    crc = (TABLE[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
