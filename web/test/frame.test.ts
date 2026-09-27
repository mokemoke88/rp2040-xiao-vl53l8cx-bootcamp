import { describe, expect, it } from "vitest";
import { cobsEncode } from "../src/cobs.ts";
import { crc32 } from "../src/crc32.ts";
import {
  FORMAT_VERSION,
  MAX_PAYLOAD_LENGTH,
  decodeSerialPacket,
  frameLength,
  parsePacket,
  parsePayload,
  type ParseResult,
} from "../src/frame.ts";
import { Receiver } from "../src/receiver.ts";
import { MAX_ENCODED_PACKET_LENGTH } from "../src/stream.ts";
import { concat, toExpectShape, vectors } from "./vectors.ts";

/** ペイロードに CRC を付ける */
function withCrc(payload: Uint8Array): Uint8Array {
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(payload), true);
  return concat(payload, crc);
}

/** ペイロードを USB シリアルの 1 パケット(COBS、区切りなし)にする */
function encodeSerial(payload: Uint8Array): Uint8Array {
  return cobsEncode(withCrc(payload));
}

/** 区切りの 00 を除く */
function stripDelimiter(serial: Uint8Array): Uint8Array {
  expect(serial[serial.length - 1]).toBe(0);
  return serial.subarray(0, serial.length - 1);
}

function reasonOf(result: ParseResult): string {
  return result.ok ? `ok:${result.message.type}` : result.reason;
}

function payloadOf(name: string): Uint8Array {
  const m = vectors.messages.find((v) => v.name === name);
  if (m === undefined) throw new Error(`vector ${name} not found`);
  return m.payload.slice();
}

describe("vectors file", () => {
  it("is format version 1", () => {
    expect(vectors.formatVersion).toBe(FORMAT_VERSION);
  });

  it("has messages of every type and invalid cases", () => {
    const types = new Set(vectors.messages.map((m) => m.expect.type));
    expect(types).toEqual(new Set(["frame", "log", "status"]));
    expect(vectors.invalid.length).toBeGreaterThan(0);
  });

  // 新しいセクションが追加されたら、ここに todo として現れる(テストの追従が必要)
  for (const section of vectors.unknownSections) {
    it.todo(`section "${section}" of frame-vectors.json is not tested yet`);
  }
});

describe("valid messages", () => {
  for (const m of vectors.messages) {
    it(`decodes ${m.name} from serial_hex`, () => {
      const serial = stripDelimiter(m.serial);
      expect(serial.includes(0)).toBe(false);
      const result = decodeSerialPacket(serial);
      if (!result.ok) throw new Error(`rejected: ${result.reason}`);
      expect(toExpectShape(result.message)).toEqual(m.expect);
    });

    it(`parses ${m.name} from payload and packet`, () => {
      const fromPayload = parsePayload(m.payload);
      const fromPacket = parsePacket(withCrc(m.payload));
      if (!fromPayload.ok || !fromPacket.ok) throw new Error("rejected");
      expect(toExpectShape(fromPayload.message)).toEqual(m.expect);
      expect(toExpectShape(fromPacket.message)).toEqual(m.expect);
    });

    it(`encodes ${m.name} to the same serial bytes`, () => {
      expect(Array.from(concat(encodeSerial(m.payload), Uint8Array.of(0)))).toEqual(
        Array.from(m.serial),
      );
    });

    it(`rejects every truncation of ${m.name}`, () => {
      const packet = withCrc(m.payload);
      for (let n = 0; n < packet.length; n++) {
        expect(parsePacket(packet.subarray(0, n)).ok, `length ${n}`).toBe(false);
      }
      // CRC を付け直しても、ペイロードの途中までは構造の検査で拒否する
      for (let n = 0; n < m.payload.length; n++) {
        expect(parsePayload(m.payload.subarray(0, n)).ok, `payload length ${n}`).toBe(false);
      }
    });

    it(`rejects every single-bit error in ${m.name}`, () => {
      const packet = withCrc(m.payload);
      // 全ビットは多いので、先頭・末尾と 7 バイトおきを調べる
      for (let i = 0; i < packet.length; i += i < 20 || i > packet.length - 8 ? 1 : 7) {
        for (let bit = 0; bit < 8; bit++) {
          const broken = packet.slice();
          broken[i] = (broken[i] ?? 0) ^ (1 << bit);
          expect(reasonOf(parsePacket(broken)), `byte ${i} bit ${bit}`).toBe("crc");
        }
      }
    });
  }
});

describe("invalid vectors", () => {
  for (const v of vectors.invalid) {
    it(`handles ${v.name} as ${v.reject}`, () => {
      // serial_hex は同期済み(直前に 0x00 を受けた)状態から流す前提
      const results: string[] = [];
      const receiver = new Receiver(
        (m) => results.push(`ok:${m.type}`),
        () => 0,
      );
      receiver.push(concat(Uint8Array.of(0), v.serial));
      const rejects = Object.entries(receiver.stats.rejects)
        .filter(([, n]) => n > 0)
        .flatMap(([r, n]) => Array<string>(n).fill(r));
      results.push(...rejects);
      if (v.reject === "ignore") {
        expect(results).toEqual([]);
      } else {
        expect(results).toEqual([v.reject]);
        // 直接デコードしても同じ理由
        const packets = splitPackets(v.serial);
        expect(packets.map((p) => reasonOf(decodeSerialPacket(p)))).toEqual([v.reject]);
      }
    });
  }
});

/** 0x00 で区切り、長さ 0 のものを除く */
function splitPackets(serial: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < serial.length; i++) {
    if (serial[i] === 0) {
      if (i > start) out.push(serial.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < serial.length) out.push(serial.subarray(start));
  return out;
}

describe("header checks built from valid payloads", () => {
  const frame = () => payloadOf("frame_4x4_all_fields");
  const log = () => payloadOf("log_info");
  const status = () => payloadOf("status");

  function check(payload: Uint8Array): string {
    return reasonOf(decodeSerialPacket(encodeSerial(payload)));
  }

  it("accepts the unmodified payloads", () => {
    expect(check(frame())).toBe("ok:frame");
    expect(check(log())).toBe("ok:log");
    expect(check(status())).toBe("ok:status");
  });

  it("rejects a payload shorter than the common header", () => {
    for (let n = 0; n < 12; n++) {
      expect(check(frame().subarray(0, n)), `n=${n}`).toBe("length");
    }
  });

  it("rejects a packet shorter than the CRC", () => {
    for (let n = 0; n < 4; n++) {
      expect(reasonOf(parsePacket(new Uint8Array(n)))).toBe("length");
    }
  });

  it("checks magic, version and type", () => {
    for (const [offset, value, reason] of [
      [0, 0x57, "magic"],
      [1, 0x39, "magic"],
      [2, 0, "version"],
      [2, 2, "version"],
      [3, 0, "type"],
      [3, 4, "type"],
    ] as const) {
      const p = frame();
      p[offset] = value;
      expect(check(p), `offset ${offset} = ${value}`).toBe(reason);
    }
  });

  it("rejects each reserved field bit (6-15) in a frame", () => {
    for (let bit = 6; bit < 16; bit++) {
      const p = frame();
      const view = new DataView(p.buffer);
      view.setUint16(14, view.getUint16(14, true) | (1 << bit), true);
      expect(check(p), `bit ${bit}`).toBe("frame_header");
    }
  });

  it("checks the frame side and targets per zone", () => {
    for (const side of [0, 3, 5, 7, 9, 16]) {
      const p = frame();
      p[12] = side;
      expect(check(p), `side ${side}`).toBe("frame_header");
    }
    for (const t of [0, 5, 255]) {
      const p = frame();
      p[13] = t;
      expect(check(p), `T ${t}`).toBe("frame_header");
    }
  });

  it("checks the frame length against the header (a smaller header is a length error)", () => {
    const p = frame();
    p[13] = 2; // T = 2 だと長さが合わない
    expect(check(p)).toBe("length");
    const q = frame();
    new DataView(q.buffer).setUint16(14, 0x001f, true); // nb_spads_enabled を外すと長さが合わない
    expect(check(q)).toBe("length");
  });

  it("rejects a frame shorter than its header", () => {
    for (let n = 12; n < 18; n++) {
      expect(check(frame().subarray(0, n)), `n=${n}`).toBe("length");
    }
  });

  it("accepts a frame with no fields (length 18)", () => {
    const p = frame().slice(0, 18);
    new DataView(p.buffer).setUint16(14, 0, true);
    expect(check(p)).toBe("ok:frame");
  });

  it("checks the log header", () => {
    const p = log();
    p[12] = 3;
    expect(check(p)).toBe("log");
    const q = log();
    q[13] = 1;
    expect(check(q)).toBe("log");
    for (let n = 12; n < 16; n++) {
      expect(check(log().subarray(0, n)), `n=${n}`).toBe("length");
    }
    expect(check(concat(log(), Uint8Array.of(0x41)))).toBe("length");
  });

  it("accepts a log with length 0 and sanitizes non-printable bytes", () => {
    const empty = log().slice(0, 16);
    new DataView(empty.buffer).setUint16(14, 0, true);
    const r = decodeSerialPacket(encodeSerial(empty));
    expect(r.ok && r.message.type === "log" ? r.message.text : null).toBe("");

    const p = concat(log().slice(0, 16), Uint8Array.of(0x41, 0x1b, 0x7f, 0x80, 0x42));
    new DataView(p.buffer).setUint16(14, 5, true);
    const q = decodeSerialPacket(encodeSerial(p));
    expect(q.ok && q.message.type === "log" ? q.message.text : null).toBe("A???B");
  });

  it("does not reject out-of-range lengths when the structure is consistent", () => {
    // ログの length 0〜200 と fw_len 0〜64 は送信側の保証。長さが整合していれば受け付ける
    const text = new Uint8Array(250).fill(0x41);
    const p = concat(log().slice(0, 16), text);
    new DataView(p.buffer).setUint16(14, 250, true);
    expect(check(p)).toBe("ok:log");
  });

  it("checks the status header", () => {
    for (const flags of [0x04, 0x80, 0xff]) {
      const p = status();
      p[17] = flags;
      expect(check(p), `flags ${flags}`).toBe("status");
    }
    for (const flags of [0, 1, 2, 3]) {
      const p = status();
      p[17] = flags;
      expect(check(p), `flags ${flags}`).toBe("ok:status");
    }
    const side = status();
    side[12] = 6;
    expect(check(side)).toBe("status");
    const t = status();
    t[13] = 0;
    expect(check(t)).toBe("status");
    const mask = status();
    new DataView(mask.buffer).setUint16(14, 0x8000, true);
    expect(check(mask)).toBe("status");
    for (let n = 12; n < 27; n++) {
      expect(check(status().subarray(0, n)), `n=${n}`).toBe("length");
    }
    const long = status();
    long[26] = (long[26] ?? 0) + 1;
    expect(check(long)).toBe("length");
  });

  it("reads flip flags from the status", () => {
    for (const [flags, h, v] of [
      [0, false, false],
      [1, true, false],
      [2, false, true],
      [3, true, true],
    ] as const) {
      const p = status();
      p[17] = flags;
      const r = decodeSerialPacket(encodeSerial(p));
      if (!r.ok || r.message.type !== "status") throw new Error("rejected");
      expect([r.message.flipH, r.message.flipV]).toEqual([h, v]);
    }
  });
});

describe("frameLength", () => {
  it("matches the examples in the spec", () => {
    expect(frameLength(8, 1, 0x3f)).toBe(914);
    expect(frameLength(4, 1, 0x03)).toBe(66);
    expect(frameLength(8, 4, 0x3f)).toBe(MAX_PAYLOAD_LENGTH);
  });

  it("separates per-target and per-zone fields", () => {
    // 4x4、T = 2: 18 + 16×2×(2+1+2+4) + 16×(1+4) = 18 + 288 + 80
    expect(frameLength(4, 2, 0x3f)).toBe(386);
    expect(frameLength(4, 2, 0x08)).toBe(18 + 16);
    expect(frameLength(4, 2, 0x20)).toBe(18 + 64);
    expect(frameLength(4, 2, 0x10)).toBe(18 + 128);
  });
});

describe("largest message", () => {
  it("decodes an 8x8 T=4 all-fields frame (the maximum payload)", () => {
    const p = new Uint8Array(MAX_PAYLOAD_LENGTH);
    p.set([0x56, 0x38, 1, 1], 0);
    p[12] = 8;
    p[13] = 4;
    new DataView(p.buffer).setUint16(14, 0x3f, true);
    // seq・timestamp とフィールドを 0x00 のない値で埋める。ヘッダには 0x00(field_mask の上位バイト、
    // 温度、reserved)が残るので、COBS 後の長さは上限(2657)より少し短い
    p.fill(0x11, 18);
    p.fill(0x11, 4, 12);
    const encoded = encodeSerial(p);
    expect(encoded.length).toBeLessThanOrEqual(MAX_ENCODED_PACKET_LENGTH);
    const r = decodeSerialPacket(encoded);
    if (!r.ok || r.message.type !== "frame") throw new Error("rejected");
    expect(r.message.fields.distance_mm?.length).toBe(256);
    expect(r.message.fields.nb_target_detected?.length).toBe(64);
    expect(r.message.fields.signal_per_spad?.[255]).toBe(0x11111111);
    expect(r.message.fields.nb_spads_enabled?.[63]).toBe(0x11111111);
  });
});
