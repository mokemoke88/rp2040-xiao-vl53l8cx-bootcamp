/**
 * USB シリアルの受信バイト列(任意の位置で分割されたチャンク)を 0x00 で区切り、
 * COBS でエンコードされたパケットを取り出す。DOM / Web API に依存しない。
 * 仕様: docs/frame-format.md の「COBS」の「長さ」と「受信側の手順」。
 */

import { cobsMaxEncodedLength } from "./cobs.ts";
import { CRC_LENGTH, MAX_PAYLOAD_LENGTH } from "./frame.ts";

/**
 * 区切りを除いた、エンコード後のパケットの最大長(版 1 で 2657 バイト)。
 * 区切りが来ないままこれを超えたら、次の 0x00 まで読み捨てる。
 */
export const MAX_ENCODED_PACKET_LENGTH = cobsMaxEncodedLength(MAX_PAYLOAD_LENGTH + CRC_LENGTH);

/** 区切りの処理で起きたこと */
export type SplitEvent =
  /** 区切られたパケット(COBS でエンコードされたまま。区切りの 0x00 は含まない。長さは 1 以上) */
  | { readonly kind: "packet"; readonly bytes: Uint8Array }
  /** 区切りが来ないまま上限を超えた。次の 0x00 までを捨てる */
  | { readonly kind: "overflow" };

/**
 * チャンクを 0x00 で区切ってパケットにする。上限付きのバッファを 1 つだけ持つ。
 *
 * - 最初の 0x00 より前のバイトは捨てる(接続時に流れていた途中のデータやテキスト表示の残り)
 * - 長さ 0 のパケット(0x00 の連続)は無視する(イベントを出さない)
 * - 上限を超えたら `overflow` を 1 回出し、次の 0x00 までを捨てる
 */
export class PacketSplitter {
  private readonly buffer: Uint8Array;
  private length = 0;
  private synced = false;
  private overflowed = false;
  private leading = 0;
  private overflowDiscarded = 0;
  private empty = 0;

  /**
   * @param maxLength - 区切りを除いたパケットの最大長 [バイト](1 以上)
   * @throws RangeError maxLength が 1 未満の整数でないとき
   */
  constructor(maxLength: number = MAX_ENCODED_PACKET_LENGTH) {
    if (!Number.isInteger(maxLength) || maxLength < 1) {
      throw new RangeError(`maxLength must be a positive integer: ${maxLength}`);
    }
    this.buffer = new Uint8Array(maxLength);
  }

  /** 最初の 0x00 より前に捨てたバイト数 */
  get leadingBytes(): number {
    return this.leading;
  }

  /** 上限を超えたパケットとして捨てたバイト数 */
  get overflowBytes(): number {
    return this.overflowDiscarded;
  }

  /** 長さ 0 のパケット(同期後に 0x00 が続いた)の数 */
  get emptyPackets(): number {
    return this.empty;
  }

  /** まだ区切られていない(次の 0x00 を待っている)バイト数 */
  get pendingBytes(): number {
    return this.length;
  }

  /** 最初の 0x00 を受け取ったか */
  get isSynced(): boolean {
    return this.synced;
  }

  /** 状態を接続直後に戻す(次の 0x00 までを再び捨てる) */
  reset(): void {
    this.length = 0;
    this.synced = false;
    this.overflowed = false;
    this.leading = 0;
    this.overflowDiscarded = 0;
    this.empty = 0;
  }

  /**
   * チャンクを追加し、このチャンクで完成したパケットなどを返す。
   *
   * @param chunk - 受信したバイト列(長さ 0 でもよい)
   * @returns 起きたことの列(受信順)
   */
  push(chunk: Uint8Array): SplitEvent[] {
    const events: SplitEvent[] = [];
    for (const b of chunk) {
      if (!this.synced) {
        if (b === 0) {
          this.synced = true;
        } else {
          this.leading++;
        }
        continue;
      }
      if (b === 0) {
        if (this.overflowed) {
          this.overflowed = false;
        } else if (this.length > 0) {
          events.push({ kind: "packet", bytes: this.buffer.slice(0, this.length) });
        } else {
          this.empty++;
        }
        this.length = 0;
        continue;
      }
      if (this.overflowed) {
        this.overflowDiscarded++;
        continue;
      }
      if (this.length >= this.buffer.length) {
        this.overflowDiscarded += this.length + 1;
        this.length = 0;
        this.overflowed = true;
        events.push({ kind: "overflow" });
        continue;
      }
      this.buffer[this.length++] = b;
    }
    return events;
  }
}
