import { describe, expect, it } from "vitest";
import { crc32 } from "../src/crc32.ts";
import { vectors } from "./vectors.ts";

describe("crc32", () => {
  it("matches the check value in the vectors", () => {
    const input = new TextEncoder().encode(vectors.crcCheck.input);
    expect(crc32(input)).toBe(vectors.crcCheck.crc32);
    expect(vectors.crcCheck.crc32).toBe(0xcbf43926);
  });

  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("matches the crc32 of every message payload", () => {
    for (const m of vectors.messages) {
      expect(crc32(m.payload), m.name).toBe(m.crc32);
    }
  });

  it("returns an unsigned value", () => {
    // 0xFF 1 バイトの CRC-32 は 0xFF000000(最上位ビットが立つ)
    expect(crc32(Uint8Array.of(0xff))).toBe(0xff000000);
  });

  it("works on a subarray with a non-zero offset", () => {
    const buf = new Uint8Array(20);
    buf.set(new TextEncoder().encode("123456789"), 7);
    expect(crc32(buf.subarray(7, 16))).toBe(0xcbf43926);
  });
});
