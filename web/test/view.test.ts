import { describe, expect, it } from "vitest";
import type { RangingFrame } from "../src/frame.ts";
import {
  AutoRange,
  OUT_OF_RANGE_COLOR,
  classifyZone,
  describeZone,
  distanceColor,
  firstTargets,
  linearPosition,
  logPosition,
  minMax,
  zoneAt,
} from "../src/view.ts";

describe("zoneAt", () => {
  it("h=1 v=0 puts zone r*side + (side-1-c) at (r, c) (spec)", () => {
    const o = { flipH: true, flipV: false };
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        expect(zoneAt(r, c, 8, o)).toBe(r * 8 + (7 - c));
      }
    }
    expect(zoneAt(0, 7, 8, o)).toBe(0); // ゾーン 0 は右上
  });

  it("covers all orientations", () => {
    expect(zoneAt(0, 0, 4, { flipH: false, flipV: false })).toBe(0);
    expect(zoneAt(0, 0, 4, { flipH: false, flipV: true })).toBe(12);
    expect(zoneAt(0, 0, 4, { flipH: true, flipV: true })).toBe(15);
    expect(zoneAt(1, 2, 4, { flipH: false, flipV: false })).toBe(6);
  });
});

function frame4(fields: RangingFrame["fields"], targetsPerZone = 1): RangingFrame {
  return {
    type: "frame",
    seq: 0,
    timestampUs: 0,
    side: 4,
    targetsPerZone,
    fieldMask: 0x3f,
    temperatureC: 0,
    fields,
  };
}

describe("classifyZone", () => {
  const f = frame4({
    distance_mm: Int16Array.from([100, 200, 300, 400, 500, 600, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    target_status: Uint8Array.from([5, 9, 255, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]),
    range_sigma_mm: Uint16Array.from([10, 50, 0, 0, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    nb_target_detected: Uint8Array.from([1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
  });

  it("follows the Step 2 order", () => {
    expect(classifyZone(f, 0)).toBe("ok");
    expect(classifyZone(f, 1)).toBe("ok"); // sigma = 上限はまだ有効
    expect(classifyZone(f, 2)).toBe("none"); // status 255
    expect(classifyZone(f, 3)).toBe("status");
    expect(classifyZone(f, 4)).toBe("sigma");
    expect(classifyZone(f, 5)).toBe("none"); // ターゲット数 0
  });

  it("skips checks for missing fields", () => {
    const only = frame4({ distance_mm: new Int16Array(16) });
    expect(classifyZone(only, 3)).toBe("ok");
    expect(classifyZone(frame4({}), 0)).toBe("nodata");
  });

  it("uses the first target when T > 1", () => {
    const t2 = frame4(
      {
        distance_mm: new Int16Array(32),
        target_status: Uint8Array.from({ length: 32 }, (_, i) => (i === 2 ? 6 : i === 3 ? 5 : 5)),
      },
      2,
    );
    expect(classifyZone(t2, 1)).toBe("status");
  });
});

describe("colors and scales", () => {
  it("maps distances from red (near) to blue (far) and marks out of range", () => {
    const near = distanceColor(0);
    const far = distanceColor(2000);
    expect(near.r).toBeGreaterThan(near.b);
    expect(far.b).toBeGreaterThan(far.r);
    expect(distanceColor(2001)).toEqual(OUT_OF_RANGE_COLOR);
    expect(distanceColor(-5)).toEqual(near);
  });

  it("computes log positions", () => {
    const r = { min: 10, max: 1000 };
    expect(logPosition(10, r)).toBe(0);
    expect(logPosition(100, r)).toBeCloseTo(0.5);
    expect(logPosition(1000, r)).toBe(1);
    expect(logPosition(0, r)).toBe(0);
    expect(logPosition(5000, r)).toBe(1);
    expect(logPosition(10, { min: 10, max: 10 })).toBe(1);
  });

  it("computes linear positions", () => {
    expect(linearPosition(15, { min: 10, max: 20 })).toBe(0.5);
    expect(linearPosition(5, { min: 10, max: 10 })).toBe(0);
  });

  it("finds min and max with a filter", () => {
    expect(minMax([3, 0, 9, 1], (v) => v > 0)).toEqual({ min: 1, max: 9 });
    expect(minMax([0, 0], (v) => v > 0)).toBeNull();
  });

  it("expands the auto range immediately and shrinks it slowly", () => {
    const a = new AutoRange(0.5);
    expect(a.update(null)).toBeNull();
    expect(a.update({ min: 10, max: 100 })).toEqual({ min: 10, max: 100 });
    expect(a.update({ min: 5, max: 200 })).toEqual({ min: 5, max: 200 });
    expect(a.update({ min: 15, max: 100 })).toEqual({ min: 10, max: 150 });
    expect(a.update(null)).toEqual({ min: 10, max: 150 });
  });
});

describe("describeZone", () => {
  it("lists every field of the zone", () => {
    const f = frame4(
      {
        distance_mm: Int16Array.from({ length: 32 }, (_, i) => i * 10),
        target_status: new Uint8Array(32).fill(5),
        range_sigma_mm: new Uint16Array(32).fill(7),
        nb_target_detected: new Uint8Array(16).fill(2),
        signal_per_spad: Uint32Array.from({ length: 32 }, (_, i) => i * 100),
        nb_spads_enabled: new Uint32Array(16).fill(1234),
      },
      2,
    );
    expect(describeZone(f, 5)).toEqual([
      "zone 5(row 1, col 1): 有効",
      "nb_target_detected: 2",
      "nb_spads_enabled: 1234",
      "target 0: distance 100 mm, status 5, sigma 7 mm, signal 1000 kcps/SPAD",
      "target 1: distance 110 mm, status 5, sigma 7 mm, signal 1100 kcps/SPAD",
    ]);
    expect(describeZone(f, 16)).toEqual([]);
    expect(describeZone(f, -1)).toEqual([]);
  });
});

describe("firstTargets", () => {
  it("returns the input for T = 1", () => {
    const v = Uint32Array.from([1, 2, 3]);
    expect(firstTargets(v, 1)).toBe(v);
  });

  it("takes t = 0 of each zone", () => {
    const v = Uint32Array.from([10, 11, 20, 21, 30, 31, 40, 41]);
    expect(Array.from(firstTargets(v, 2))).toEqual([10, 20, 30, 40]);
    const w = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(firstTargets(w, 4))).toEqual([1, 5, 9]);
  });

  it("rejects an invalid T", () => {
    expect(() => firstTargets(new Uint32Array(4), 0)).toThrow(/targetsPerZone/);
    expect(() => firstTargets(new Uint32Array(4), 1.5)).toThrow(/targetsPerZone/);
  });
});
