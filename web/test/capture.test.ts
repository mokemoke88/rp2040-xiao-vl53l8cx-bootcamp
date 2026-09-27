/**
 * 実機の記録をデコードするテスト。
 * 記録: 2026-09-27、COM7、tools/capture_serial.py で 6 秒、step3 のファームウェア(8x8、15 Hz、全フィールド)。
 * 同じ記録を tools/verification/decode_capture.py で読んだ結果(Python の別実装)と一致することを確かめる。
 */

import { describe, expect, it } from "vitest";
import type { Message } from "../src/frame.ts";
import { Receiver } from "../src/receiver.ts";
import { buildReplaySchedule } from "../src/replay.ts";
import captureDataUrl from "./fixtures/step3_cap_20260927.bin?inline";

/** `?inline` の data URL(base64)をバイト列に戻す */
function fromDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || !url.slice(0, comma).endsWith(";base64")) {
    throw new Error(`unexpected inline asset: ${url.slice(0, 40)}`);
  }
  const binary = atob(url.slice(comma + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const capture = fromDataUrl(captureDataUrl);

function decode(chunks: Iterable<Uint8Array>): { messages: Message[]; receiver: Receiver } {
  const messages: Message[] = [];
  const receiver = new Receiver(
    (m) => messages.push(m),
    () => 0,
  );
  for (const c of chunks) receiver.push(c);
  return { messages, receiver };
}

describe("real capture (step3, 2026-09-27)", () => {
  it("has the recorded size", () => {
    expect(capture.length).toBe(85886);
  });

  it("decodes without rejects or missing messages", () => {
    const { messages, receiver } = decode([capture]);
    const s = receiver.stats;
    expect(receiver.leadingBytes).toBe(2083);
    expect(receiver.pendingBytes).toBe(0);
    expect(receiver.emptyPackets).toBe(0);
    expect(s.totalRejects).toBe(0);
    expect(s.counts).toEqual({ frame: 91, log: 0, status: 1 });
    expect([s.sequence.gaps, s.sequence.missing, s.sequence.backwards]).toEqual([0, 0, 0]);
    expect(s.intervals.gaps).toBe(0);

    const status = messages[0];
    if (status?.type !== "status") throw new Error("first message is not a status");
    expect(status.seq).toBe(0);
    expect(status.side).toBe(8);
    expect(status.fieldMask).toBe(0x3f);
    expect(status.rangingHz).toBe(15);
    expect([status.flipH, status.flipV]).toEqual([true, false]);
    expect(status.i2cHz).toBe(399361);
    expect(status.sensorReadBytes).toBe(972);
    expect(status.firmwareVersion).toBe("xiao-vl53l8cx-bootcamp step3 (ULD VL53L8CX_2.0.0)");

    for (const m of messages.slice(1)) {
      if (m.type !== "frame") throw new Error(`unexpected ${m.type}`);
      expect(m.side).toBe(8);
      expect(m.targetsPerZone).toBe(1);
      expect(m.fields.signal_per_spad?.length).toBe(64);
      expect(m.fields.nb_spads_enabled?.length).toBe(64);
    }
    // decode_capture.py: 15.22 fps、間隔 65417〜70660 µs
    expect(s.sensorRate.rate()).toBeGreaterThan(14);
    expect(s.sensorRate.rate()).toBeLessThan(16);
    expect(s.intervals.maxIntervalUs).toBe(70660);
  });

  it("gives the same result when fed in 64-byte chunks", () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < capture.length; i += 64) chunks.push(capture.subarray(i, i + 64));
    const { messages, receiver } = decode(chunks);
    expect(messages.length).toBe(92);
    expect(receiver.stats.totalRejects).toBe(0);
  });

  it("replays through the schedule into the same result", () => {
    const schedule = buildReplaySchedule(capture, { mode: "timestamp", maxGapMs: 1000 });
    const { messages, receiver } = decode(schedule.map((s) => s.bytes));
    expect(messages.length).toBe(92);
    expect(receiver.stats.totalRejects).toBe(0);
    // 記録時の時間(最初と最後のフレームの間)は 90 間隔ぶん
    const total = schedule.reduce((sum, s) => sum + s.delayMs, 0);
    expect(total).toBeGreaterThan(90 * 65);
    expect(total).toBeLessThan(90 * 71);
  });
});
