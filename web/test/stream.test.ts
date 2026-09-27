import { describe, expect, it } from "vitest";
import type { Message } from "../src/frame.ts";
import { Receiver } from "../src/receiver.ts";
import { MAX_ENCODED_PACKET_LENGTH, PacketSplitter } from "../src/stream.ts";
import { concat, rng, toExpectShape, vectors, type StreamExpect } from "./vectors.ts";

/** すべての正しいメッセージを連結したストリーム(同期用の 0x00 を先頭に付ける) */
function allMessagesStream(): Uint8Array {
  return concat(Uint8Array.of(0), ...vectors.messages.map((m) => m.serial));
}

/** chunks の順にレシーバに流し、受け取ったメッセージと拒否の数を返す */
function run(chunks: Uint8Array[]): { messages: Message[]; receiver: Receiver } {
  const messages: Message[] = [];
  const receiver = new Receiver(
    (m) => messages.push(m),
    () => 0,
  );
  for (const c of chunks) receiver.push(c);
  return { messages, receiver };
}

/** data を cuts の位置で切る */
function cutAt(data: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [0, ...cuts.filter((c) => c > 0 && c < data.length).sort((a, b) => a - b)];
  points.push(data.length);
  const out: Uint8Array[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    out.push(data.subarray(points[i], points[i + 1]));
  }
  return out;
}

describe("PacketSplitter", () => {
  it("discards bytes before the first 0x00", () => {
    const s = new PacketSplitter();
    expect(s.push(Uint8Array.of(0x41, 0x42, 0x43))).toEqual([]);
    expect(s.isSynced).toBe(false);
    expect(s.push(Uint8Array.of(0x44, 0x00, 0x05, 0x06, 0x00))).toEqual([
      { kind: "packet", bytes: Uint8Array.of(0x05, 0x06) },
    ]);
    expect(s.leadingBytes).toBe(4);
  });

  it("ignores and counts empty packets after synchronization only", () => {
    const s = new PacketSplitter();
    expect(s.push(Uint8Array.of(0, 0, 0, 7, 0, 0))).toEqual([
      { kind: "packet", bytes: Uint8Array.of(7) },
    ]);
    // 最初の 0x00 は同期。続く 0x00 0x00 で長さ 0 が 2 つ、7 の後の 0x00 が区切りで、最後の 0x00 が 3 つ目
    expect(s.emptyPackets).toBe(3);
  });

  it("reports bytes waiting for a delimiter", () => {
    const s = new PacketSplitter();
    s.push(Uint8Array.of(0, 1, 2, 3));
    expect(s.pendingBytes).toBe(3);
    s.push(Uint8Array.of(0));
    expect(s.pendingBytes).toBe(0);
  });

  it("accepts a packet of exactly the maximum length and overflows one byte later", () => {
    const max = MAX_ENCODED_PACKET_LENGTH;
    expect(max).toBe(2657);
    const s = new PacketSplitter();
    const exact = new Uint8Array(max).fill(1);
    const events = s.push(concat(Uint8Array.of(0), exact, Uint8Array.of(0)));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === "packet" ? events[0].bytes.length : -1).toBe(max);

    const over = new Uint8Array(max + 1).fill(1);
    expect(s.push(concat(over, Uint8Array.of(0)))).toEqual([{ kind: "overflow" }]);
  });

  it("reports one overflow per oversized packet, discards until 0x00 and recovers", () => {
    const s = new PacketSplitter(4);
    const events = s.push(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 9, 8, 0));
    expect(events).toEqual([{ kind: "overflow" }, { kind: "packet", bytes: Uint8Array.of(9, 8) }]);
    expect(s.overflowBytes).toBe(9);
    expect(s.emptyPackets).toBe(0);
    // バッファは上限の大きさから増えない(上限付き)
    expect(s.push(Uint8Array.of(1, 2, 3, 4, 0))).toEqual([
      { kind: "packet", bytes: Uint8Array.of(1, 2, 3, 4) },
    ]);
  });

  it("returns copies that are not overwritten by later packets", () => {
    const s = new PacketSplitter();
    const [a] = s.push(Uint8Array.of(0, 1, 2, 0));
    s.push(Uint8Array.of(3, 4, 0));
    expect(a).toEqual({ kind: "packet", bytes: Uint8Array.of(1, 2) });
  });

  it("starts over after reset", () => {
    const s = new PacketSplitter();
    s.push(Uint8Array.of(0, 1, 2));
    s.reset();
    expect(s.push(Uint8Array.of(3, 0, 4, 0))).toEqual([
      { kind: "packet", bytes: Uint8Array.of(4) },
    ]);
  });

  it("rejects an invalid maximum", () => {
    expect(() => new PacketSplitter(0)).toThrow(RangeError);
    expect(() => new PacketSplitter(1.5)).toThrow(RangeError);
  });
});

/** ストリームを流した結果を、テストベクタの streams の expect と同じ形にする */
function streamResult(chunks: Uint8Array[]): StreamExpect {
  const { messages, receiver } = run(chunks);
  const s = receiver.stats;
  return {
    leading_bytes: receiver.leadingBytes,
    trailing_bytes: receiver.pendingBytes,
    empty_packets: receiver.emptyPackets,
    accepted: messages.length,
    accepted_by_type: { ...s.counts },
    rejected: Object.fromEntries(Object.entries(s.rejects).filter(([, n]) => n > 0)),
    accepted_seqs: messages.map((m) => m.seq),
    gaps: s.sequence.gaps,
    missing_messages: s.sequence.missing,
    backward: s.sequence.backwards,
  };
}

describe("stream vectors", () => {
  it("has stream vectors", () => {
    expect(vectors.streams.length).toBeGreaterThan(0);
  });

  for (const v of vectors.streams) {
    it(`matches ${v.name} in one chunk`, () => {
      expect(streamResult([v.serial])).toEqual(v.expect);
    });

    it(`matches ${v.name} for every split position and byte by byte`, () => {
      for (let cut = 1; cut < v.serial.length; cut++) {
        expect(streamResult(cutAt(v.serial, [cut])), `cut ${cut}`).toEqual(v.expect);
      }
      expect(streamResult(Array.from(v.serial, (b) => Uint8Array.of(b)))).toEqual(v.expect);
    });
  }
});

describe("Receiver", () => {
  const expected = vectors.messages.map((m) => m.expect);

  it("decodes all vector messages from one chunk", () => {
    const { messages, receiver } = run([allMessagesStream()]);
    expect(messages.map(toExpectShape)).toEqual(expected);
    expect(receiver.stats.totalRejects).toBe(0);
  });

  it("gives the same result for every single split position", () => {
    const data = allMessagesStream();
    for (let cut = 1; cut < data.length; cut++) {
      const { messages, receiver } = run(cutAt(data, [cut]));
      expect(messages.length, `cut ${cut}`).toBe(expected.length);
      expect(receiver.stats.totalRejects, `cut ${cut}`).toBe(0);
    }
  });

  it("gives the same result for byte-by-byte and random chunking", () => {
    const data = allMessagesStream();
    const bytes = Array.from(data, (b) => Uint8Array.of(b));
    expect(run(bytes).messages.map(toExpectShape)).toEqual(expected);
    const next = rng(7);
    for (let trial = 0; trial < 50; trial++) {
      const cuts = Array.from({ length: 1 + Math.floor(next() * 20) }, () =>
        Math.floor(next() * data.length),
      );
      const { messages, receiver } = run(cutAt(data, cuts));
      expect(messages.map(toExpectShape), `trial ${trial}`).toEqual(expected);
      expect(receiver.stats.totalRejects).toBe(0);
    }
  });

  it("ignores text before the first 0x00", () => {
    const text = new TextEncoder().encode("frame 123 | temp 31C\r\n");
    const { messages, receiver } = run([concat(text, allMessagesStream())]);
    expect(messages.map(toExpectShape)).toEqual(expected);
    expect(receiver.leadingBytes).toBe(text.length);
  });

  it("rejects a packet cut by a 0x00 in the middle and resynchronizes", () => {
    const first = vectors.messages[0];
    const second = vectors.messages[1];
    if (first === undefined || second === undefined) throw new Error("need 2 messages");
    // 最初のメッセージの途中で 0x00 が入った(途中までしか送られなかった)場合
    const cut = first.serial.subarray(0, 20);
    const { messages, receiver } = run([
      concat(Uint8Array.of(0), cut, Uint8Array.of(0), second.serial),
    ]);
    expect(messages.map(toExpectShape)).toEqual([second.expect]);
    expect(receiver.stats.totalRejects).toBe(1);
  });

  it("counts an overflow and recovers at the next 0x00", () => {
    const junk = new Uint8Array(MAX_ENCODED_PACKET_LENGTH + 10).fill(0x33);
    const { messages, receiver } = run([concat(Uint8Array.of(0), junk, allMessagesStream())]);
    expect(messages.map(toExpectShape)).toEqual(expected);
    expect(receiver.stats.rejects.overflow).toBe(1);
    expect(receiver.stats.totalRejects).toBe(1);
  });

  it("decodes nothing before synchronization", () => {
    const withoutSync = concat(...vectors.messages.map((m) => m.serial));
    const { messages } = run([withoutSync]);
    // 最初のメッセージは同期のために捨てられ、残りは読める
    expect(messages.map(toExpectShape)).toEqual(expected.slice(1));
  });

  it("resets the splitter and statistics", () => {
    const { receiver, messages } = run([allMessagesStream()]);
    receiver.reset();
    expect(receiver.stats.counts.frame).toBe(0);
    receiver.push(vectors.messages[0]?.serial ?? new Uint8Array());
    expect(messages.length).toBe(expected.length);
  });
});
