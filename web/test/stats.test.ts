import { describe, expect, it } from "vitest";
import type { Message, RangingFrame, StatusMessage } from "../src/frame.ts";
import {
  FrameIntervalMonitor,
  RateMeter,
  ReceiveStats,
  SequenceTracker,
  TimestampRate,
  u32Diff,
} from "../src/stats.ts";

function frame(seq: number, timestampUs = 0): RangingFrame {
  return {
    type: "frame",
    seq,
    timestampUs,
    side: 4,
    targetsPerZone: 1,
    fieldMask: 0,
    temperatureC: 0,
    fields: {},
  };
}

function status(seq: number, rangingHz: number): StatusMessage {
  return {
    type: "status",
    seq,
    timestampUs: 0,
    side: 8,
    targetsPerZone: 1,
    fieldMask: 0x3f,
    rangingHz,
    flags: 1,
    flipH: true,
    flipV: false,
    i2cHz: 399361,
    sensorReadBytes: 972,
    firmwareVersion: "x",
  };
}

describe("u32Diff", () => {
  it("wraps modulo 2^32", () => {
    expect(u32Diff(5, 3)).toBe(2);
    expect(u32Diff(0, 0xffffffff)).toBe(1);
    expect(u32Diff(3, 5)).toBe(0xfffffffe);
    expect(u32Diff(0, 0)).toBe(0);
  });
});

describe("SequenceTracker", () => {
  function track(seqs: number[]): SequenceTracker {
    const t = new SequenceTracker();
    for (const s of seqs) t.onMessage(s);
    return t;
  }

  it("counts nothing for consecutive numbers", () => {
    const t = track([10, 11, 12, 13]);
    expect([t.missing, t.backwards]).toEqual([0, 0]);
  });

  it("does not count the first message", () => {
    expect(track([123456]).missing).toBe(0);
  });

  it("counts missing messages", () => {
    const t = track([1, 2, 5, 6, 8]);
    expect([t.gaps, t.missing, t.backwards]).toEqual([2, 3, 0]);
  });

  it("wraps at 2^32 without counting", () => {
    const t = track([0xfffffffe, 0xffffffff, 0, 1]);
    expect([t.missing, t.backwards]).toEqual([0, 0]);
    expect(track([0xfffffffe, 1]).missing).toBe(2);
  });

  it("counts a backward jump once instead of a huge gap", () => {
    const t = track([100, 101, 3, 4]);
    expect([t.missing, t.backwards]).toEqual([0, 1]);
    // 同じ番号の繰り返しも逆戻り
    expect(track([7, 7]).backwards).toBe(1);
  });

  it("treats a gap of 2^31 - 1 as missing and 2^31 as backwards", () => {
    // (seq − prev − 1) mod 2^32 が 2^31 未満なら欠落
    expect(track([0, 0x80000000]).missing).toBe(0x7fffffff);
    expect(track([0, 0x80000000]).backwards).toBe(0);
    expect(track([0, 0x80000001]).backwards).toBe(1);
    expect(track([0, 0x80000001]).missing).toBe(0);
  });

  it("resets", () => {
    const t = track([1, 5]);
    t.reset();
    t.onMessage(100);
    expect([t.missing, t.backwards]).toEqual([0, 0]);
  });
});

describe("ReceiveStats", () => {
  it("keeps prev across rejects so that rejected messages count as missing", () => {
    const s = new ReceiveStats();
    s.onMessage(frame(1), 0);
    s.onReject("crc");
    s.onMessage(frame(3), 66);
    expect(s.sequence.missing).toBe(1);
    expect(s.rejects.crc).toBe(1);
    expect(s.totalRejects).toBe(1);
  });

  it("counts messages by type and sequence across types", () => {
    const s = new ReceiveStats();
    const msgs: Message[] = [
      status(1, 15),
      frame(2),
      { type: "log", seq: 3, timestampUs: 0, level: 0, text: "" },
      frame(4),
    ];
    for (const m of msgs) s.onMessage(m, 0);
    expect(s.counts).toEqual({ frame: 2, log: 1, status: 1 });
    expect(s.sequence.missing).toBe(0);
  });

  it("counts every reject reason and resets", () => {
    const s = new ReceiveStats();
    s.onReject("overflow");
    s.onReject("cobs");
    s.onReject("cobs");
    expect(s.rejects.cobs).toBe(2);
    expect(s.totalRejects).toBe(3);
    s.reset();
    expect(s.totalRejects).toBe(0);
  });

  it("uses the ranging frequency from the status for interval gaps", () => {
    const s = new ReceiveStats();
    s.onMessage(frame(1, 0), 0);
    s.onMessage(frame(2, 200_000), 0);
    expect(s.intervals.gaps).toBe(0); // 周期が分からないうちは数えない
    s.onMessage(status(3, 15), 0);
    s.onMessage(frame(4, 266_667), 0);
    s.onMessage(frame(5, 466_667), 0); // 200 ms = 3 周期
    expect(s.intervals.gaps).toBe(1);
    expect(s.intervals.skippedFrames).toBe(2);
  });
});

describe("FrameIntervalMonitor", () => {
  const period = 1e6 / 15;

  function monitor(timestamps: number[]): FrameIntervalMonitor {
    const m = new FrameIntervalMonitor();
    m.setRangingHz(15);
    for (const t of timestamps) m.add(t);
    return m;
  }

  it("does not count normal intervals or jitter up to 1.5 periods", () => {
    const m = monitor([0, period, 2 * period, 3 * period + 0.5 * period - 1]);
    expect(m.gaps).toBe(0);
  });

  it("does not count exactly 1.5 periods", () => {
    // 15 Hz の 1.5 周期はちょうど 100000 µs
    const m = monitor([0, 100_000]);
    expect(m.gaps).toBe(0);
    expect(monitor([0, 100_001]).gaps).toBe(1);
  });

  it("counts intervals over 1.5 periods", () => {
    const m = monitor([0, 1.5 * period + 2]);
    expect(m.gaps).toBe(1);
    expect(m.skippedFrames).toBe(1);
    const n = monitor([0, 7 * period]);
    expect(n.skippedFrames).toBe(6);
  });

  it("handles the timestamp wrap and ignores backward jumps", () => {
    const m = monitor([0xffffffff - 10_000, Math.round(period) - 10_001]);
    expect(m.gaps).toBe(0);
    expect(m.maxIntervalUs).toBe(Math.round(period));
    const b = monitor([5_000_000, 1000]);
    expect(b.gaps).toBe(0);
    expect(b.maxIntervalUs).toBe(0);
  });

  it("does not count without a period", () => {
    const m = new FrameIntervalMonitor();
    m.add(0);
    m.add(1_000_000);
    expect(m.gaps).toBe(0);
    expect(m.maxIntervalUs).toBe(1_000_000);
  });
});

describe("RateMeter", () => {
  it("computes the rate over the window", () => {
    const r = new RateMeter(2000);
    for (let i = 0; i < 16; i++) r.add(i * 66.667);
    expect(r.rate(1000)).toBeCloseTo(15, 1);
  });

  it("drops old events and returns 0 with fewer than two", () => {
    const r = new RateMeter(1000);
    expect(r.rate(0)).toBe(0);
    r.add(0);
    r.add(100);
    expect(r.rate(500)).toBeCloseTo(10);
    expect(r.rate(1050)).toBe(0);
  });
});

describe("TimestampRate", () => {
  it("computes the sender rate across the wrap", () => {
    const r = new TimestampRate(15);
    let t = 0xffffffff - 500_000;
    for (let i = 0; i < 20; i++) {
      r.add(t >>> 0);
      t += 66_667;
    }
    expect(r.rate()).toBeCloseTo(15, 2);
  });

  it("drops history on a long gap", () => {
    const r = new TimestampRate(15, 2_000_000);
    r.add(0);
    r.add(100_000);
    r.add(5_000_000);
    expect(r.rate()).toBe(0);
    r.add(5_050_000);
    expect(r.rate()).toBeCloseTo(20);
  });
});
