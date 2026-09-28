import { describe, expect, it } from "vitest";
import type { RangingFrame } from "../src/frame.ts";
import {
  AutoRange,
  blueRampColor,
  OUT_OF_RANGE_COLOR,
  classifyTarget,
  classifyZone,
  describeZone,
  distanceColor,
  firstTargets,
  grayColor,
  linearPosition,
  logPosition,
  minMax,
  zoneAt,
  zoneValueColor,
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

describe("classifyTarget", () => {
  // T = 2。zone 0: 2 つ検出(t0 ok、t1 ok)、zone 1: 2 つ検出(t0 status 6、t1 ok)、zone 2: 1 つ検出(t1 は検出外)、
  // zone 3: 2 つ検出(t0 ok、t1 sigma 超え)、zone 4: 2 つ検出(t1 が 255)、zone 5: 検出 0
  const status = [5, 5, 6, 9, 5, 5, 5, 5, 5, 255, 5, 5];
  const sigma = [10, 20, 10, 20, 10, 10, 10, 51, 10, 10, 10, 10];
  const detected = [2, 2, 1, 2, 2, 0];
  const t2 = frame4(
    {
      distance_mm: Int16Array.from({ length: 32 }, (_, i) => 100 + i),
      target_status: Uint8Array.from({ length: 32 }, (_, i) => status[i] ?? 5),
      range_sigma_mm: Uint16Array.from({ length: 32 }, (_, i) => sigma[i] ?? 10),
      nb_target_detected: Uint8Array.from({ length: 16 }, (_, z) => detected[z] ?? 1),
    },
    2,
  );

  it("judges each target by its own status and sigma", () => {
    expect(classifyTarget(t2, 0, 0)).toBe("ok");
    expect(classifyTarget(t2, 0, 1)).toBe("ok");
    expect(classifyTarget(t2, 1, 0)).toBe("status");
    expect(classifyTarget(t2, 1, 1)).toBe("ok"); // 手前が無効でも奥は有効
    expect(classifyTarget(t2, 3, 1)).toBe("sigma");
    expect(classifyTarget(t2, 4, 1)).toBe("none"); // status 255
  });

  it("treats targets beyond nb_target_detected as none", () => {
    expect(classifyTarget(t2, 2, 0)).toBe("ok");
    expect(classifyTarget(t2, 2, 1)).toBe("none"); // 検出 1 つ: t = 1 は検出外
    expect(classifyTarget(t2, 5, 0)).toBe("none"); // 検出 0
  });

  it("matches classifyZone for target 0", () => {
    for (let zone = 0; zone < 16; zone++) {
      expect(classifyTarget(t2, zone, 0)).toBe(classifyZone(t2, zone));
    }
  });

  it("returns nodata without distances and skips missing fields", () => {
    expect(classifyTarget(frame4({}, 2), 0, 1)).toBe("nodata");
    expect(classifyTarget(frame4({ distance_mm: new Int16Array(32) }, 2), 3, 1)).toBe("ok");
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

describe("zoneValueColor", () => {
  const f = frame4({
    distance_mm: Int16Array.from({ length: 16 }, (_, i) => i * 100),
    signal_per_spad: Uint32Array.from({ length: 16 }, (_, i) => 10 ** (1 + (i % 3))),
    nb_spads_enabled: Uint32Array.from({ length: 16 }, (_, i) => 100 + i),
  });
  const ranges = { signal: { min: 10, max: 1000 }, spads: { min: 100, max: 115 } };

  it("uses the same color functions as the 2D images", () => {
    expect(zoneValueColor(f, 3, "distance", ranges)).toEqual(distanceColor(300));
    expect(zoneValueColor(f, 0, "signal", ranges)).toEqual({ r: 0, g: 0, b: 0 });
    expect(zoneValueColor(f, 2, "signal", ranges)).toEqual({ r: 255, g: 255, b: 255 });
    expect(zoneValueColor(f, 1, "signal", ranges)?.r).toBeCloseTo(127.5);
    expect(zoneValueColor(f, 15, "spads", ranges)).toEqual(blueRampColor(1));
    expect(zoneValueColor(f, 0, "spads", ranges)).toEqual(blueRampColor(0));
  });

  it("returns null without the field or the range", () => {
    expect(zoneValueColor(frame4({}), 0, "distance", ranges)).toBeNull();
    expect(zoneValueColor(f, 0, "signal", { signal: null, spads: null })).toBeNull();
    expect(zoneValueColor(f, 0, "spads", { signal: null, spads: null })).toBeNull();
  });
});

describe("zoneValueColor with T = 2", () => {
  // ターゲットごと(signal)は zone × T + 0、ゾーンごと(SPAD 数)は zone を使う
  const f = frame4(
    {
      distance_mm: Int16Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 100 : 1900)),
      signal_per_spad: Uint32Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 1000 : 10)),
      nb_spads_enabled: Uint32Array.from({ length: 16 }, (_, i) => (i < 8 ? 100 : 200)),
    },
    2,
  );
  const ranges = { signal: { min: 10, max: 1000 }, spads: { min: 100, max: 200 } };

  it("uses the first target for per-target fields and the zone for per-zone fields", () => {
    expect(zoneValueColor(f, 5, "distance", ranges)).toEqual(distanceColor(100));
    expect(zoneValueColor(f, 5, "signal", ranges)).toEqual(grayColor(1));
    // zone 5 の SPAD 数は 100(添字 5)。ターゲットの添字(10)を使うと 200 になる
    expect(zoneValueColor(f, 5, "spads", ranges)).toEqual(blueRampColor(0));
    expect(zoneValueColor(f, 9, "spads", ranges)).toEqual(blueRampColor(1));
  });

  it("uses the given target for per-target fields", () => {
    expect(zoneValueColor(f, 5, "distance", ranges, 1)).toEqual(distanceColor(1900));
    expect(zoneValueColor(f, 5, "signal", ranges, 1)).toEqual(grayColor(0));
    // SPAD 数はゾーンごとなので、ターゲットによらない(zone 7 は 100、隣の zone 8 は 200)
    expect(zoneValueColor(f, 7, "spads", ranges, 1)).toEqual(blueRampColor(0));
  });
});
