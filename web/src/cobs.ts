/**
 * COBS(Consistent Overhead Byte Stuffing)のエンコードとデコード。
 * 仕様: docs/frame-format.md の「COBS(USB シリアル)」。区切りの 0x00 はここでは扱わない。
 */

/**
 * エンコード後の長さの最大値を返す(0x00 を含まない入力で最大になる)。
 *
 * @param n - 入力のバイト数(0 以上)
 * @returns n = 0 なら 1、それ以外は n + ⌈n / 254⌉
 */
export function cobsMaxEncodedLength(n: number): number {
  return n === 0 ? 1 : n + Math.ceil(n / 254);
}

/**
 * バイト列を COBS でエンコードする。出力に 0x00 は含まれない(区切りの 0x00 は付けない)。
 * 入力が「0x00 を含まない 254 バイトのブロック」で終わるときは後ろに 0x01 を足さない。
 *
 * @param data - 入力(任意のバイト列)
 * @returns エンコードしたバイト列
 */
export function cobsEncode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(cobsMaxEncodedLength(data.length));
  let codePos = 0;
  let outLen = 1;
  let code = 1;
  for (let i = 0; i < data.length; i++) {
    const b = data[i] ?? 0;
    if (b === 0) {
      out[codePos] = code;
      codePos = outLen++;
      code = 1;
    } else {
      out[outLen++] = b;
      code++;
      if (code === 0xff) {
        out[codePos] = 0xff;
        code = 1;
        if (i === data.length - 1) {
          return out.slice(0, outLen);
        }
        codePos = outLen++;
      }
    }
  }
  out[codePos] = code;
  return out.slice(0, outLen);
}

/**
 * COBS でエンコードされたバイト列(区切りの 0x00 を除いたもの)をデコードする。
 * 最後の 254 バイトのブロックの後ろに余分な 0x01 がある符号化も受け付ける。
 *
 * @param encoded - エンコードされたバイト列
 * @returns デコードしたバイト列。コード 0x00、コードが終わりを越える、データの途中に 0x00 があるときは null
 */
export function cobsDecode(encoded: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(encoded.length);
  let outLen = 0;
  let i = 0;
  while (i < encoded.length) {
    const code = encoded[i] ?? 0;
    i++;
    if (code === 0 || i + code - 1 > encoded.length) {
      return null;
    }
    const end = i + code - 1;
    for (; i < end; i++) {
      const b = encoded[i] ?? 0;
      if (b === 0) {
        return null;
      }
      out[outLen++] = b;
    }
    if (code !== 0xff && i < encoded.length) {
      out[outLen++] = 0;
    }
  }
  return out.slice(0, outLen);
}
