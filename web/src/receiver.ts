/**
 * 受信の組み立て: チャンク → 0x00 区切り → COBS / CRC / 形式の検証 → メッセージ + 統計。
 * Web Serial と記録ファイルの再生の両方がこれにチャンクを渡す。DOM / Web API に依存しない。
 */

import { decodeSerialPacket, type Message } from "./frame.ts";
import { ReceiveStats } from "./stats.ts";
import { PacketSplitter } from "./stream.ts";

/**
 * USB シリアルのバイト列を受け取り、正しいメッセージを `onMessage` に渡す。拒否は統計に数える。
 */
export class Receiver {
  /** 受信の統計 */
  readonly stats = new ReceiveStats();
  private readonly splitter: PacketSplitter;
  private readonly onMessage: (message: Message) => void;
  private readonly now: () => number;

  /**
   * @param onMessage - 正しいメッセージを受け取るたびに呼ばれる
   * @param now - 現在時刻 [ms] を返す関数(レートの計算に使う)
   * @param maxPacketLength - 区切りを除いたパケットの最大長(省略時は版 1 の上限)
   * @throws RangeError maxPacketLength が 1 未満の整数でないとき
   */
  constructor(onMessage: (message: Message) => void, now: () => number, maxPacketLength?: number) {
    this.onMessage = onMessage;
    this.now = now;
    this.splitter = new PacketSplitter(maxPacketLength);
  }

  /** 最初の 0x00 より前に捨てたバイト数 */
  get leadingBytes(): number {
    return this.splitter.leadingBytes;
  }

  /** 上限を超えたパケットとして捨てたバイト数 */
  get overflowBytes(): number {
    return this.splitter.overflowBytes;
  }

  /** 長さ 0 のパケットの数(無視したもの。拒否には数えない) */
  get emptyPackets(): number {
    return this.splitter.emptyPackets;
  }

  /** まだ区切られていないバイト数 */
  get pendingBytes(): number {
    return this.splitter.pendingBytes;
  }

  /**
   * 受信したチャンクを処理する。
   *
   * @param chunk - 受信したバイト列(任意の位置で分割されていてよい)
   */
  push(chunk: Uint8Array): void {
    for (const event of this.splitter.push(chunk)) {
      if (event.kind === "overflow") {
        this.stats.onReject("overflow");
        continue;
      }
      const result = decodeSerialPacket(event.bytes);
      if (result.ok) {
        this.stats.onMessage(result.message, this.now());
        this.onMessage(result.message);
      } else {
        this.stats.onReject(result.reason);
      }
    }
  }

  /** 区切りの状態と統計を接続直後に戻す */
  reset(): void {
    this.splitter.reset();
    this.stats.reset();
  }
}
