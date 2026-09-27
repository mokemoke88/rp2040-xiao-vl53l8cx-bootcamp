import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cobsEncode } from "../src/cobs.ts";
import { crc32 } from "../src/crc32.ts";
import { Receiver } from "../src/receiver.ts";
import { ReplayPlayer, buildReplaySchedule, splitAfterDelimiters } from "../src/replay.ts";
import { concat, vectors } from "./vectors.ts";

/** frame_4x4_distance_status の seq と timestamp を差し替えて、USB シリアルのバイト列にする */
function frameAt(seq: number, timestampUs: number): Uint8Array {
  const base = vectors.messages.find((m) => m.name === "frame_4x4_distance_status");
  if (base === undefined) throw new Error("vector not found");
  const p = base.payload.slice();
  const view = new DataView(p.buffer);
  view.setUint32(4, seq, true);
  view.setUint32(8, timestampUs >>> 0, true);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(p), true);
  return concat(cobsEncode(concat(p, crc)), Uint8Array.of(0));
}

describe("splitAfterDelimiters", () => {
  it("splits after each 0x00 and keeps a trailing remainder", () => {
    const parts = splitAfterDelimiters(Uint8Array.of(1, 0, 0, 2, 3, 0, 4));
    expect(parts.map((p) => Array.from(p))).toEqual([[1, 0], [0], [2, 3, 0], [4]]);
    expect(splitAfterDelimiters(new Uint8Array(0))).toEqual([]);
  });
});

describe("buildReplaySchedule", () => {
  const capture = concat(
    new TextEncoder().encode("text"),
    Uint8Array.of(0),
    frameAt(1, 0xffffffff - 33_333),
    frameAt(2, 33_334), // 折り返しをまたいで 66.668 ms
    Uint8Array.of(0x05, 0x01, 0x00), // 壊れたパケット
    frameAt(4, 5_000_000), // 大きな間隔(上限で頭打ち)
    frameAt(5, 1000), // 逆戻り
  );

  it("uses timestamp intervals, clamps long gaps and ignores backward jumps", () => {
    const s = buildReplaySchedule(capture, { mode: "timestamp", maxGapMs: 1000 });
    expect(s.map((x) => x.delayMs)).toEqual([0, 0, 66.668, 0, 1000, 0]);
    expect(concat(...s.map((x) => x.bytes))).toEqual(capture);
  });

  it("uses a fixed rate for frames only", () => {
    const s = buildReplaySchedule(capture, { mode: "fixed", fps: 10 });
    expect(s.map((x) => x.delayMs)).toEqual([0, 100, 100, 0, 100, 100]);
  });

  it("rejects invalid timing", () => {
    expect(() => buildReplaySchedule(capture, { mode: "fixed", fps: 0 })).toThrow(RangeError);
    expect(() => buildReplaySchedule(capture, { mode: "timestamp", maxGapMs: -1 })).toThrow(
      RangeError,
    );
  });
});

describe("ReplayPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("feeds the receiver in time and ends", () => {
    const capture = concat(
      Uint8Array.of(0),
      frameAt(1, 0),
      frameAt(2, 100_000),
      frameAt(3, 200_000),
    );
    const seqs: number[] = [];
    const receiver = new Receiver(
      (m) => seqs.push(m.seq),
      () => 0,
    );
    let ended = false;
    const player = new ReplayPlayer({
      sink: (b) => {
        receiver.push(b);
      },
      onEnd: () => {
        ended = true;
      },
    });
    player.load(buildReplaySchedule(capture, { mode: "timestamp", maxGapMs: 1000 }));
    player.play();
    vi.advanceTimersByTime(1);
    expect(seqs).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(seqs).toEqual([1, 2]);
    player.pause();
    vi.advanceTimersByTime(1000);
    expect(seqs).toEqual([1, 2]);
    player.play();
    vi.advanceTimersByTime(200);
    expect(seqs).toEqual([1, 2, 3]);
    expect(ended).toBe(true);
    expect(player.state).toBe("stopped");
    expect(receiver.stats.sequence.missing).toBe(0);
  });

  it("applies the speed", () => {
    const capture = concat(Uint8Array.of(0), frameAt(1, 0), frameAt(2, 100_000));
    const seqs: number[] = [];
    const receiver = new Receiver(
      (m) => seqs.push(m.seq),
      () => 0,
    );
    const player = new ReplayPlayer({
      sink: (b) => {
        receiver.push(b);
      },
    });
    player.speed = 2;
    player.load(buildReplaySchedule(capture, { mode: "timestamp", maxGapMs: 1000 }));
    player.play();
    vi.advanceTimersByTime(51);
    expect(seqs).toEqual([1, 2]);
  });

  /** 先頭にテキストがある(最初の 0x00 の前に捨てるバイトがある)記録 */
  const loopCapture = concat(
    new TextEncoder().encode("abc"),
    Uint8Array.of(0),
    frameAt(1, 0),
    frameAt(2, 100_000),
    frameAt(3, 200_000),
  );

  it("resets the receiver at each loop seam so that the second pass has no rejects", () => {
    const seqs: number[] = [];
    const receiver = new Receiver(
      (m) => seqs.push(m.seq),
      () => 0,
    );
    let restarts = 0;
    const player = new ReplayPlayer({
      sink: (b) => {
        receiver.push(b);
      },
      onRestart: () => {
        restarts++;
        receiver.reset();
      },
      onEnd: () => {
        throw new Error("onEnd must not be called while looping");
      },
    });
    player.loop = true;
    player.load(buildReplaySchedule(loopCapture, { mode: "timestamp", maxGapMs: 1000 }));
    player.play();
    // 1 周は 200 ms(frame 1〜3 が 0 / 100 / 200 ms)。継ぎ目で待たずに次の周の先頭を流す
    vi.advanceTimersByTime(150);
    expect(seqs).toEqual([1, 2]);
    expect(restarts).toBe(1);
    // 2 周目: 継ぎ目で受信処理がリセットされ、先頭のテキストは再び同期前として捨てられる
    vi.advanceTimersByTime(200);
    expect(seqs).toEqual([1, 2, 3, 1, 2]);
    expect(restarts).toBe(2);
    expect(player.state).toBe("playing");
    const s = receiver.stats;
    expect(s.totalRejects).toBe(0);
    expect([s.sequence.gaps, s.sequence.backwards]).toEqual([0, 0]);
    expect(receiver.leadingBytes).toBe(3);
    player.stop();
  });

  it("shows why the reset is needed: without it the seam is rejected and seq goes back", () => {
    const receiver = new Receiver(
      () => undefined,
      () => 0,
    );
    const player = new ReplayPlayer({
      sink: (b) => {
        receiver.push(b);
      },
    });
    player.loop = true;
    player.load(buildReplaySchedule(loopCapture, { mode: "timestamp", maxGapMs: 1000 }));
    player.play();
    vi.advanceTimersByTime(350); // 継ぎ目を 1 回またぐ
    player.stop();
    expect(receiver.stats.rejects.cobs).toBe(1);
    expect(receiver.stats.sequence.backwards).toBe(1);
  });

  it("does not rush queued segments after a long delay", () => {
    // Date はフェイクタイマーの時計。setSystemTime でタイマーを動かさずに時計だけ進め、
    // タブが裏に回ってタイマーが遅れた状況を作る
    const seqs: number[] = [];
    const receiver = new Receiver(
      (m) => seqs.push(m.seq),
      () => 0,
    );
    const player = new ReplayPlayer({
      sink: (b) => {
        receiver.push(b);
      },
      now: () => Date.now(),
    });
    const capture = concat(
      Uint8Array.of(0),
      frameAt(1, 0),
      frameAt(2, 100_000),
      frameAt(3, 200_000),
      frameAt(4, 300_000),
    );
    player.load(buildReplaySchedule(capture, { mode: "timestamp", maxGapMs: 1000 }));
    player.play();
    vi.advanceTimersByTime(1);
    expect(seqs).toEqual([1]);
    vi.setSystemTime(Date.now() + 2000);
    vi.advanceTimersByTime(100); // frame 2 のタイマーが 2 秒遅れて動いた
    expect(seqs).toEqual([1, 2]);
    // 遅れを取り戻そうとして frame 3・4 を一気に流さず、そこから 100 ms ずつ待つ
    vi.advanceTimersByTime(50);
    expect(seqs).toEqual([1, 2]);
    vi.advanceTimersByTime(60);
    expect(seqs).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(100);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it("catches up small delays without drifting", () => {
    const seqs: number[] = [];
    const receiver = new Receiver(
      (m) => seqs.push(m.seq),
      () => 0,
    );
    const player = new ReplayPlayer({
      sink: (b) => {
        receiver.push(b);
      },
      now: () => Date.now(),
    });
    const capture = concat(
      Uint8Array.of(0),
      frameAt(1, 0),
      frameAt(2, 100_000),
      frameAt(3, 200_000),
    );
    player.load(buildReplaySchedule(capture, { mode: "timestamp", maxGapMs: 1000 }));
    player.play();
    vi.advanceTimersByTime(1);
    vi.setSystemTime(Date.now() + 80); // 上限(500 ms)未満の遅れ
    vi.advanceTimersByTime(100);
    expect(seqs).toEqual([1, 2]);
    // 予定どおり(開始から 200 ms)に frame 3 を流すため、待ちは 100 − 80 ms ほどに縮む
    vi.advanceTimersByTime(25);
    expect(seqs).toEqual([1, 2, 3]);
  });
});
