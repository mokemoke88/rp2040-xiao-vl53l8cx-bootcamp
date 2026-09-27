/**
 * 記録ファイル(tools/capture_serial.py が保存した USB シリアルの生のバイト列)の再生。
 * DOM に依存しない(タイマーは setTimeout を使う)。
 *
 * 記録ファイルには受信時刻が入っていないので、「記録時の時間」はメッセージのタイムスタンプ
 * (送信側の起動からの µs)から求める。
 */

import { decodeSerialPacket } from "./frame.ts";
import { u32Diff } from "./stats.ts";

/** 再生する 1 区間 */
export interface ReplaySegment {
  /** 受信処理に渡すバイト列(0x00 で終わる。ファイルの最後だけは終わらないことがある) */
  readonly bytes: Uint8Array;
  /** 前の区間を渡してから、これを渡すまでの待ち [ms](速度 1 倍のとき) */
  readonly delayMs: number;
}

/** 再生の時間の決め方 */
export type ReplayTiming =
  /** 測距フレーム・ログ・状態のタイムスタンプの間隔で待つ。間隔は maxGapMs で頭打ちにする */
  | { readonly mode: "timestamp"; readonly maxGapMs: number }
  /** 測距フレームを一定の頻度で渡す(ログ・状態・拒否されたパケットは待たずに渡す) */
  | { readonly mode: "fixed"; readonly fps: number };

/**
 * バイト列を 0x00 の直後で切り分ける。各区間は 0x00 で終わる(最後の区間だけは終わらないことがある)。
 *
 * @param data - 記録のバイト列
 * @returns 区間の列(data の部分配列。連結すると data に戻る)
 */
export function splitAfterDelimiters(data: Uint8Array): Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (;;) {
    const zero = data.indexOf(0, start);
    if (zero < 0) {
      break;
    }
    segments.push(data.subarray(start, zero + 1));
    start = zero + 1;
  }
  if (start < data.length) {
    segments.push(data.subarray(start));
  }
  return segments;
}

/**
 * 記録を再生の区間の列にする。最初の区間(最初の 0x00 まで)は受信処理が捨てるが、そのまま渡す
 * (受信処理の振る舞いを実機と同じにするため)。
 *
 * @param data - 記録のバイト列
 * @param timing - 時間の決め方
 * @returns 再生の区間の列
 * @throws RangeError timing の値が正でないとき
 */
export function buildReplaySchedule(data: Uint8Array, timing: ReplayTiming): ReplaySegment[] {
  if (timing.mode === "fixed" && !(timing.fps > 0)) {
    throw new RangeError(`fps must be positive: ${timing.fps}`);
  }
  if (timing.mode === "timestamp" && !(timing.maxGapMs >= 0)) {
    throw new RangeError(`maxGapMs must not be negative: ${timing.maxGapMs}`);
  }
  let prevTimestamp: number | null = null;
  return splitAfterDelimiters(data).map((bytes, index) => {
    // 最初の区間は受信処理が捨てるので、時間の計算にも使わない
    const body = bytes[bytes.length - 1] === 0 ? bytes.subarray(0, bytes.length - 1) : bytes;
    if (index === 0 || body.length === 0) {
      return { bytes, delayMs: 0 };
    }
    const result = decodeSerialPacket(body);
    if (!result.ok) {
      return { bytes, delayMs: 0 };
    }
    const message = result.message;
    if (timing.mode === "fixed") {
      return { bytes, delayMs: message.type === "frame" ? 1000 / timing.fps : 0 };
    }
    let delayMs = 0;
    if (prevTimestamp !== null) {
      const diffUs = u32Diff(message.timestampUs, prevTimestamp);
      // 2^31 以上は時刻の逆戻り(送信側の再起動など)とみなして待たない
      delayMs = diffUs >= 0x8000_0000 ? 0 : Math.min(diffUs / 1000, timing.maxGapMs);
    }
    prevTimestamp = message.timestampUs;
    return { bytes, delayMs };
  });
}

/** 再生の状態 */
export type ReplayState = "stopped" | "playing" | "paused";

/** ReplayPlayer の設定 */
export interface ReplayPlayerOptions {
  /** 区間のバイト列を受信処理に渡す */
  readonly sink: (bytes: Uint8Array) => void;
  /**
   * 先頭の区間を渡す直前に呼ばれる(止まった状態からの再生開始と、繰り返しの継ぎ目の両方)。
   * 受信処理をリセットするのに使う。リセットしないと、継ぎ目で前の周の途中のバイト列と
   * 次の周の先頭(最初の 0x00 までのテキスト)がつながって 1 つのパケットとして拒否され、
   * seq も前の周の最後から戻って後退として数えられる
   */
  readonly onRestart?: () => void;
  /** 最後まで再生したとき(loop が false の場合)に呼ばれる */
  readonly onEnd?: () => void;
  /** 現在時刻 [ms](省略時は performance.now。テストで時計を差し替えるため) */
  readonly now?: () => number;
}

/** 予定時刻からこれ以上遅れたら、遅れを取り戻さずに予定を今に合わせる [ms] */
export const REPLAY_MAX_LAG_MS = 500;

/**
 * 区間の列を、待ち時間に沿って受信処理に渡す。
 * 待ちは区間ごとの setTimeout で、予定時刻からの遅れは次の待ちで取り戻す(ずれが積み上がらない)。
 * ただし REPLAY_MAX_LAG_MS を超えて遅れた(タブが裏に回ってタイマーが間引かれた等)ときは、
 * 取り戻そうとして溜まった区間を一気に流さず、予定を今に合わせ直す。
 */
export class ReplayPlayer {
  private segments: readonly ReplaySegment[] = [];
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextDueMs = 0;
  private currentState: ReplayState = "stopped";
  private readonly options: ReplayPlayerOptions;
  private readonly now: () => number;

  /** 再生の速度(1 = 記録時の速さ) */
  speed = 1;
  /** 最後まで再生したら最初に戻る */
  loop = false;

  constructor(options: ReplayPlayerOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  /** 現在の状態 */
  get state(): ReplayState {
    return this.currentState;
  }

  /** 再生した区間の数と全体の数 */
  get progress(): { readonly done: number; readonly total: number } {
    return { done: this.index, total: this.segments.length };
  }

  /** 区間の列を読み込む(再生中なら止める) */
  load(segments: readonly ReplaySegment[]): void {
    this.stop();
    this.segments = segments;
  }

  /** 先頭(または一時停止した位置)から再生する */
  play(): void {
    if (this.currentState === "playing" || this.segments.length === 0) {
      return;
    }
    this.currentState = "playing";
    this.nextDueMs = this.now();
    this.scheduleNext();
  }

  /** 一時停止する */
  pause(): void {
    if (this.currentState !== "playing") {
      return;
    }
    this.clearTimer();
    this.currentState = "paused";
  }

  /** 止めて先頭に戻す */
  stop(): void {
    this.clearTimer();
    this.index = 0;
    this.currentState = "stopped";
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.index >= this.segments.length) {
      if (this.loop) {
        this.index = 0;
      } else {
        this.currentState = "stopped";
        this.index = 0;
        this.options.onEnd?.();
        return;
      }
    }
    const segment = this.segments[this.index];
    if (segment === undefined) {
      return;
    }
    this.nextDueMs += segment.delayMs / this.speed;
    const wait = Math.max(0, this.nextDueMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = this.now();
      if (now - this.nextDueMs > REPLAY_MAX_LAG_MS) {
        this.nextDueMs = now;
      }
      if (this.index === 0) {
        this.options.onRestart?.();
      }
      this.index++;
      this.options.sink(segment.bytes);
      if (this.currentState === "playing") {
        this.scheduleNext();
      }
    }, wait);
  }
}
