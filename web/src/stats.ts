/**
 * 受信の統計(シーケンスの欠落・逆戻り、拒否の数、受信レート)。DOM / Web API に依存しない。
 * 時刻は呼び出し側が渡す(テストで決定的にするため)。
 */

import type { Message, RejectReason } from "./frame.ts";

/** 拒否の理由(形式の理由に、区切りの上限超えの `overflow` を加えたもの) */
export type StreamRejectReason = RejectReason | "overflow";

/** 表示の順に並べた拒否の理由 */
export const STREAM_REJECT_REASONS: readonly StreamRejectReason[] = [
  "cobs",
  "length",
  "crc",
  "magic",
  "version",
  "type",
  "frame_header",
  "log",
  "status",
  "overflow",
];

const TWO_POW_32 = 0x1_0000_0000;
const TWO_POW_31 = 0x8000_0000;

/**
 * `(a − b) mod 2^32` を返す(u32 の差。結果は 0〜2^32−1)。
 *
 * @param a - u32 の値
 * @param b - u32 の値
 */
export function u32Diff(a: number, b: number): number {
  return (((a - b) % TWO_POW_32) + TWO_POW_32) % TWO_POW_32;
}

/**
 * シーケンス番号から欠落と後退を数える(docs/frame-format.md の「シーケンス番号」)。
 * 最後に受け付けたメッセージの seq を prev として、d = `(seq − prev − 1) mod 2^32` を見る。
 *
 * - d = 0: 欠落なし
 * - 1 ≤ d < 2^31: 欠落 1 回、欠落数 d(拒否したパケットも、欠けたメッセージとしてここに現れる)
 * - d ≥ 2^31: 後退 1 回(送信側の再起動や記録の継ぎ目)
 * - どの場合も後で prev = seq。拒否や長さ 0 のパケットでは prev を変えない。最初の 1 つは比較しない
 */
export class SequenceTracker {
  private prev: number | null = null;
  /** 欠落の回数 */
  gaps = 0;
  /** 欠けたメッセージの数の累計 */
  missing = 0;
  /** 後退の回数 */
  backwards = 0;

  /** 正しいメッセージを受け付けたときに呼ぶ */
  onMessage(seq: number): void {
    if (this.prev !== null) {
      const d = u32Diff(u32Diff(seq, this.prev), 1);
      if (d >= TWO_POW_31) {
        this.backwards++;
      } else if (d > 0) {
        this.gaps++;
        this.missing += d;
      }
    }
    this.prev = seq;
  }

  /** 累計と prev を消す */
  reset(): void {
    this.prev = null;
    this.gaps = 0;
    this.missing = 0;
    this.backwards = 0;
  }
}

/**
 * 直近の時間窓に入った出来事の数からレート [回/秒] を求める。
 */
export class RateMeter {
  private times: number[] = [];
  private readonly windowMs: number;

  /**
   * @param windowMs - 時間窓 [ms]
   */
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
  }

  /** 出来事を 1 つ記録する */
  add(nowMs: number): void {
    this.times.push(nowMs);
    this.prune(nowMs);
  }

  /**
   * レートを返す。窓の中の出来事が 2 つ未満なら 0。
   *
   * @param nowMs - 現在時刻 [ms](add と同じ時計)
   */
  rate(nowMs: number): number {
    this.prune(nowMs);
    const first = this.times[0];
    const last = this.times[this.times.length - 1];
    if (first === undefined || last === undefined || last <= first) {
      return 0;
    }
    return ((this.times.length - 1) * 1000) / (last - first);
  }

  /** 記録を消す */
  reset(): void {
    this.times = [];
  }

  private prune(nowMs: number): void {
    const limit = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this.times.length && (this.times[drop] ?? limit) < limit) {
      drop++;
    }
    if (drop > 0) {
      this.times.splice(0, drop);
    }
  }
}

/**
 * 送信側のタイムスタンプ(µs、u32 で折り返す)の間隔から、送信側のフレームレートを求める。
 * 直近 `count` 個の間隔の合計から計算する。間隔が `maxGapUs` を超えたら(記録の途切れ・再起動)履歴を捨てる。
 */
export class TimestampRate {
  private prev: number | null = null;
  private intervals: number[] = [];
  private readonly count: number;
  private readonly maxGapUs: number;

  /**
   * @param count - 平均する間隔の数
   * @param maxGapUs - これを超える間隔で履歴を捨てる [µs]
   */
  constructor(count = 15, maxGapUs = 2_000_000) {
    this.count = count;
    this.maxGapUs = maxGapUs;
  }

  /** フレームのタイムスタンプを記録する */
  add(timestampUs: number): void {
    if (this.prev !== null) {
      const d = u32Diff(timestampUs, this.prev);
      if (d === 0 || d > this.maxGapUs) {
        this.intervals = [];
      } else {
        this.intervals.push(d);
        if (this.intervals.length > this.count) {
          this.intervals.shift();
        }
      }
    }
    this.prev = timestampUs;
  }

  /** レート [Hz]。間隔がまだなければ 0 */
  rate(): number {
    const sum = this.intervals.reduce((a, b) => a + b, 0);
    return sum > 0 ? (this.intervals.length * 1e6) / sum : 0;
  }

  /** 履歴を消す */
  reset(): void {
    this.prev = null;
    this.intervals = [];
  }
}

/** 周期の何倍を超えた間隔を「間隔の異常」とするか */
export const INTERVAL_GAP_FACTOR = 1.5;

/**
 * 測距フレームのタイムスタンプの間隔の異常を数える。
 * ホストの読み出しが遅れて送信側の測距ループが止まると、その間のフレームは作られないので seq には現れない。
 * これをタイムスタンプの間隔(周期の INTERVAL_GAP_FACTOR 倍超)で検出する。
 * 周期は状態メッセージの ranging_hz から決める(受け取るまでは数えない)。
 */
export class FrameIntervalMonitor {
  private prev: number | null = null;
  private periodUs: number | null = null;
  /** 間隔が周期の INTERVAL_GAP_FACTOR 倍を超えた回数 */
  gaps = 0;
  /** 間隔の異常から推定した、作られなかった(または届かなかった)フレームの数の累計 */
  skippedFrames = 0;
  /** これまでの最大の間隔 [µs](逆戻りは除く) */
  maxIntervalUs = 0;

  /**
   * 周期を設定する。
   *
   * @param rangingHz - 測距の頻度 [Hz]。0 以下なら周期を未設定に戻す
   */
  setRangingHz(rangingHz: number): void {
    this.periodUs = rangingHz > 0 ? 1e6 / rangingHz : null;
  }

  /** 測距フレームのタイムスタンプを記録する */
  add(timestampUs: number): void {
    const prev = this.prev;
    this.prev = timestampUs;
    if (prev === null) {
      return;
    }
    const d = u32Diff(timestampUs, prev);
    if (d >= TWO_POW_31) {
      // 時刻の逆戻り(送信側の再起動など)。間隔としては扱わない
      return;
    }
    this.maxIntervalUs = Math.max(this.maxIntervalUs, d);
    if (this.periodUs !== null && d > this.periodUs * INTERVAL_GAP_FACTOR) {
      this.gaps++;
      this.skippedFrames += Math.max(1, Math.round(d / this.periodUs) - 1);
    }
  }

  /** 記録と周期を消す */
  reset(): void {
    this.prev = null;
    this.periodUs = null;
    this.gaps = 0;
    this.skippedFrames = 0;
    this.maxIntervalUs = 0;
  }
}

/** メッセージ種別ごとの受信数 */
export interface MessageCounts {
  frame: number;
  log: number;
  status: number;
}

/**
 * 受信の統計をまとめたもの。
 */
export class ReceiveStats {
  readonly sequence = new SequenceTracker();
  readonly frameRate = new RateMeter();
  readonly sensorRate = new TimestampRate();
  readonly intervals = new FrameIntervalMonitor();
  readonly counts: MessageCounts = { frame: 0, log: 0, status: 0 };
  readonly rejects: Record<StreamRejectReason, number> = ReceiveStats.zeroRejects();

  private static zeroRejects(): Record<StreamRejectReason, number> {
    return {
      cobs: 0,
      length: 0,
      crc: 0,
      magic: 0,
      version: 0,
      type: 0,
      frame_header: 0,
      log: 0,
      status: 0,
      overflow: 0,
    };
  }

  /**
   * 正しいメッセージを受け取ったときに呼ぶ。
   *
   * @param message - 解析したメッセージ
   * @param nowMs - 受信した時刻 [ms]
   */
  onMessage(message: Message, nowMs: number): void {
    this.sequence.onMessage(message.seq);
    this.counts[message.type]++;
    if (message.type === "frame") {
      this.frameRate.add(nowMs);
      this.sensorRate.add(message.timestampUs);
      this.intervals.add(message.timestampUs);
    } else if (message.type === "status") {
      this.intervals.setRangingHz(message.rangingHz);
    }
  }

  /** パケットを拒否したときに呼ぶ(シーケンスの prev は変えない) */
  onReject(reason: StreamRejectReason): void {
    this.rejects[reason]++;
  }

  /** 拒否の合計 */
  get totalRejects(): number {
    return STREAM_REJECT_REASONS.reduce((sum, r) => sum + this.rejects[r], 0);
  }

  /** すべての統計を消す */
  reset(): void {
    this.sequence.reset();
    this.frameRate.reset();
    this.sensorRate.reset();
    this.intervals.reset();
    this.counts.frame = 0;
    this.counts.log = 0;
    this.counts.status = 0;
    for (const r of STREAM_REJECT_REASONS) {
      this.rejects[r] = 0;
    }
  }
}
