import { describe, expect, it } from "vitest";
import { cobsDecode, cobsEncode, cobsMaxEncodedLength } from "../src/cobs.ts";
import { rng, vectors } from "./vectors.ts";

describe("cobs vectors", () => {
  it("has vectors", () => {
    expect(vectors.cobs.length).toBeGreaterThan(0);
    expect(vectors.cobsDecodeOnly.length).toBeGreaterThan(0);
  });

  for (const v of vectors.cobs) {
    it(`encodes and decodes ${v.name}`, () => {
      expect(Array.from(cobsEncode(v.decoded))).toEqual(Array.from(v.encoded));
      expect(Array.from(cobsDecode(v.encoded) ?? [-1])).toEqual(Array.from(v.decoded));
    });
  }

  for (const v of vectors.cobsDecodeOnly) {
    it(`decodes the non-canonical ${v.name}`, () => {
      expect(Array.from(cobsDecode(v.encoded) ?? [-1])).toEqual(Array.from(v.decoded));
    });
  }
});

describe("cobsDecode malformed input and boundaries", () => {
  it("a zero code", () => {
    expect(cobsDecode(Uint8Array.of(0x00))).toBeNull();
    expect(cobsDecode(Uint8Array.of(0x02, 0x11, 0x00))).toBeNull();
  });

  it("a code past the end", () => {
    expect(cobsDecode(Uint8Array.of(0x05, 0x11, 0x22))).toBeNull();
    expect(cobsDecode(Uint8Array.of(0x02))).toBeNull();
  });

  it("a code that reaches exactly the end", () => {
    expect(Array.from(cobsDecode(Uint8Array.of(0x03, 0x11, 0x22)) ?? [-1])).toEqual([0x11, 0x22]);
  });

  it("a zero inside a block", () => {
    expect(cobsDecode(Uint8Array.of(0x04, 0x11, 0x00, 0x22))).toBeNull();
  });
});

describe("cobs round trip", () => {
  it("round-trips random data and respects the maximum length", () => {
    const next = rng(12345);
    for (let trial = 0; trial < 300; trial++) {
      const n = Math.floor(next() * 800);
      const zeroRate = next();
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        data[i] = next() < zeroRate ? 0 : 1 + Math.floor(next() * 255);
      }
      const enc = cobsEncode(data);
      expect(enc.includes(0)).toBe(false);
      expect(enc.length).toBeLessThanOrEqual(cobsMaxEncodedLength(n));
      expect(Array.from(cobsDecode(enc) ?? [-1])).toEqual(Array.from(data));
    }
  });

  it("reaches the maximum length for zero-free input", () => {
    for (const n of [1, 253, 254, 255, 508, 509, 2646]) {
      const data = new Uint8Array(n).fill(0x5a);
      expect(cobsEncode(data).length, `n=${n}`).toBe(cobsMaxEncodedLength(n));
    }
    expect(cobsMaxEncodedLength(0)).toBe(1);
    expect(cobsMaxEncodedLength(2646)).toBe(2657);
  });
});
