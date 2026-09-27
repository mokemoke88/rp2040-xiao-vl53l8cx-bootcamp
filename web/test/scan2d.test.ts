import { describe, expect, it } from "vitest";
import type { RangingFrame } from "../src/frame.ts";
import { zoneAnglesDeg } from "../src/geometry.ts";
import { sweepAngleDeg } from "../src/lidarView.ts";
import { Receiver } from "../src/receiver.ts";
import {
  DEFAULT_MOTION_OPTIONS,
  EMPTY_BACKGROUND_MM,
  MotionDetector,
  ScanHistory,
  ScanSimulator,
  bandRows,
  projectTop,
  scanLine,
  sensorColumn,
} from "../src/scan2d.ts";
import { zoneAt, type Orientation } from "../src/view.ts";
import captureDataUrl from "./fixtures/step3_cap_20260927.bin?inline";

const H1V0: Orientation = { flipH: true, flipV: false };
const TAN = (deg: number): number => Math.tan((deg * Math.PI) / 180);

/** 8x8(または side)の測距フレーム。未指定のゾーンは 1000 mm、ステータス 5、sigma 10、ターゲット 1 */
function frame(
  opts: {
    side?: number;
    distance?: (zone: number) => number;
    status?: (zone: number) => number;
    sigma?: (zone: number) => number;
    seq?: number;
  } = {},
): RangingFrame {
  const side = opts.side ?? 8;
  const zones = side * side;
  const d = opts.distance ?? (() => 1000);
  const st = opts.status ?? (() => 5);
  const sg = opts.sigma ?? (() => 10);
  return {
    type: "frame",
    seq: opts.seq ?? 0,
    timestampUs: 0,
    side,
    targetsPerZone: 1,
    fieldMask: 0x0f,
    temperatureC: 0,
    fields: {
      distance_mm: Int16Array.from({ length: zones }, (_, z) => d(z)),
      target_status: Uint8Array.from({ length: zones }, (_, z) => st(z)),
      range_sigma_mm: Uint16Array.from({ length: zones }, (_, z) => sg(z)),
      nb_target_detected: new Uint8Array(zones).fill(1),
    },
  };
}

/** 正面から見た図の (行, 列) のゾーン(h=1 v=0) */
const Z = (row: number, col: number, side = 8): number => zoneAt(row, col, side, H1V0);

/**
 * 8x8、T = 2 の測距フレーム。ターゲットごとの値は (ゾーン, t) の関数で決める。
 * ターゲット 1(t = 1)には、添字を取り違えたときに結果が変わる値を入れて使う
 */
function frameT2(opts: {
  distance: (zone: number, t: number) => number;
  status?: (zone: number, t: number) => number;
  sigma?: (zone: number, t: number) => number;
}): RangingFrame {
  const per = (f: (zone: number, t: number) => number): number[] =>
    Array.from({ length: 128 }, (_, i) => f(Math.floor(i / 2), i % 2));
  return {
    type: "frame",
    seq: 0,
    timestampUs: 0,
    side: 8,
    targetsPerZone: 2,
    fieldMask: 0x0f,
    temperatureC: 0,
    fields: {
      distance_mm: Int16Array.from(per(opts.distance)),
      target_status: Uint8Array.from(per(opts.status ?? (() => 5))),
      range_sigma_mm: Uint16Array.from(per(opts.sigma ?? (() => 10))),
      nb_target_detected: new Uint8Array(64).fill(2),
    },
  };
}

describe("sensorColumn and projectTop", () => {
  it("counts sensor columns from the sensor's left (the front view's right)", () => {
    expect(sensorColumn(0, 8, H1V0)).toBe(0); // zone 0 は正面から見て右上 = センサーから見て左
    expect(sensorColumn(Z(0, 0), 8, H1V0)).toBe(7);
    expect(sensorColumn(0, 8, { flipH: false, flipV: false })).toBe(7);
    for (let c = 0; c < 8; c++) {
      // センサーから見た列が右へ進むほど、水平の角度が増える
      const left = zoneAnglesDeg(Z(2, 7 - c), 8, H1V0).ax;
      expect(sensorColumn(Z(2, 7 - c), 8, H1V0)).toBe(c);
      if (c > 0) expect(left).toBeGreaterThan(zoneAnglesDeg(Z(2, 8 - c), 8, H1V0).ax);
    }
  });

  it("places zones at x = d·tan(ax), z = d (perpendicular) and skips non-positive distances", () => {
    const f = frame({ distance: (z) => (z === 5 ? 0 : 1000 + z) });
    const pts = projectTop(f, H1V0);
    expect(pts).toHaveLength(63);
    expect(pts.some((p) => p.zone === 5)).toBe(false);
    const p0 = pts.find((p) => p.zone === 0);
    expect(p0?.z).toBeCloseTo(1000, 9);
    expect(p0?.x).toBeCloseTo(1000 * TAN(zoneAnglesDeg(0, 8, H1V0).ax), 9);
    expect(p0?.x).toBeLessThan(0);
    expect(p0?.row).toBe(0);
    expect(p0?.sensorCol).toBe(0);
  });

  it("uses the radius when asked (lecture C)", () => {
    const pts = projectTop(frame(), H1V0, "radial");
    const p = pts.find((q) => q.zone === 0);
    if (p === undefined) throw new Error("missing");
    const a = zoneAnglesDeg(0, 8, H1V0);
    expect(p.z).toBeCloseTo(1000 / Math.hypot(TAN(a.ax), TAN(a.ay), 1), 9);
  });
});

describe("bandRows", () => {
  it("picks all rows or the two central rows", () => {
    expect(bandRows(8, "all")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(bandRows(8, "center")).toEqual([3, 4]);
    expect(bandRows(4, "center")).toEqual([1, 2]);
    expect(() => bandRows(5, "all")).toThrow(RangeError);
    expect(() => bandRows(0, "all")).toThrow(RangeError);
  });
});

describe("scanLine", () => {
  it("takes the nearest valid zone per sensor column within the band", () => {
    // センサーから見て左端の列(正面から見て列 7): 行 0 に 300 mm、行 3 に 800 mm、行 4 に 900 mm
    const f = frame({
      distance: (z) => (z === Z(0, 7) ? 300 : z === Z(3, 7) ? 800 : z === Z(4, 7) ? 900 : 1500),
    });
    const center = scanLine(f, H1V0, "center");
    expect(center).toHaveLength(8);
    expect(center[0]?.distanceMm).toBe(800); // 行 0 は帯の外
    expect(scanLine(f, H1V0, "all")[0]?.distanceMm).toBe(300);
    expect(center[1]?.distanceMm).toBe(1500);
  });

  it("orders columns from the sensor's left and places points on the horizontal plane", () => {
    const scan = scanLine(frame(), H1V0, "all");
    expect(scan.map((s) => s.sensorCol)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(scan[0]?.angleDeg).toBeCloseTo(-19.6875, 9);
    expect(scan[7]?.angleDeg).toBeCloseTo(19.6875, 9);
    for (const s of scan) {
      expect(s.z).toBeCloseTo(1000, 9);
      expect(s.x).toBeCloseTo(1000 * TAN(s.angleDeg), 9);
    }
  });

  it("ignores invalid zones and gives null when a column has none", () => {
    const col0 = new Set([Z(3, 7), Z(4, 7)]);
    const f = frame({
      distance: (z) => (z === Z(3, 7) ? 200 : 1000),
      status: (z) => (col0.has(z) ? 255 : z === Z(3, 6) ? 6 : 5),
      sigma: (z) => (z === Z(4, 6) ? 80 : 10),
    });
    const scan = scanLine(f, H1V0, "center");
    expect(scan[0]).toMatchObject({ distanceMm: null, x: null, z: null });
    // 列 1(正面から見て列 6): 行 3 はステータス無効、行 4 は sigma 超え → なし
    expect(scan[1]?.distanceMm).toBeNull();
    expect(scan[2]?.distanceMm).toBe(1000);
  });

  it("skips non-positive distances even with a valid status", () => {
    const f = frame({ distance: (z) => (z === Z(3, 7) ? -20 : z === Z(4, 7) ? 0 : 1000) });
    expect(scanLine(f, H1V0, "center")[0]?.distanceMm).toBeNull();
  });

  it("uses the first target (t = 0) with T = 2", () => {
    // ターゲット 0 は 1000 mm、ターゲット 1 は 300 mm(近い)。左端の列の行 3 だけターゲット 0 を 700 mm に
    const f = frameT2({ distance: (z, t) => (t === 1 ? 300 : z === Z(3, 7) ? 700 : 1000) });
    const scan = scanLine(f, H1V0, "center");
    expect(scan[0]?.distanceMm).toBe(700);
    expect(scan[1]?.distanceMm).toBe(1000);
    // ターゲット 0 のステータスが無効なら除く(ターゲット 1 のステータスは見ない)
    const g = frameT2({
      distance: () => 1000,
      status: (z, t) => (t === 0 && (z === Z(3, 7) || z === Z(4, 7)) ? 6 : 5),
    });
    expect(scanLine(g, H1V0, "center")[0]?.distanceMm).toBeNull();
  });

  it("works for 4x4", () => {
    const scan = scanLine(frame({ side: 4 }), H1V0, "center");
    expect(scan).toHaveLength(4);
    expect(scan[0]?.angleDeg).toBeCloseTo(-16.875, 9);
  });
});

describe("ScanHistory", () => {
  const scan = scanLine(frame(), H1V0, "all");

  it("fades linearly and drops entries at the duration", () => {
    const h = new ScanHistory(1500);
    h.add(1000, scan);
    expect(h.visible(1000).map((v) => v.alpha)).toEqual([1]);
    h.add(1750, scan);
    const mid = h.visible(1750);
    expect(mid.map((v) => v.alpha)).toEqual([0.5, 1]);
    expect(mid[0]?.entry.timeMs).toBe(1000); // 古い順
    expect(h.visible(2499).map((v) => v.alpha)[0]).toBeCloseTo(1 / 1500, 9);
    expect(h.visible(2500).map((v) => v.entry.timeMs)).toEqual([1750]); // ちょうど 1.5 秒で消える
    expect(h.visible(3250)).toEqual([]);
  });

  it("stays bounded when add is called without visible", () => {
    // LiDAR 風ビューが表示されていない間も add は続く。期限切れと上限で捨てる
    const h = new ScanHistory(1500, 64);
    for (let i = 0; i < 1000; i++) {
      h.add(i * 66.7, scan);
      expect(h.size).toBeLessThanOrEqual(23); // 1.5 秒 / 66.7 ms = 22.5 本
    }
    const dense = new ScanHistory(1500, 10);
    for (let i = 0; i < 100; i++) {
      dense.add(i, scan); // 1 ms ごと: 期限切れにはならず、上限で捨てる
      expect(dense.size).toBeLessThanOrEqual(10);
    }
    expect(dense.visible(99).map((v) => v.entry.timeMs)).toEqual([
      90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    ]);
    expect(() => new ScanHistory(1500, 0)).toThrow(RangeError);
    expect(() => new ScanHistory(1500, 2.5)).toThrow(RangeError);
  });

  it("drops expired entries on add", () => {
    const h = new ScanHistory(1500);
    h.add(0, scan);
    h.add(1499, scan);
    expect(h.size).toBe(2);
    h.add(1500, scan); // 0 の分はちょうど 1.5 秒で期限切れ
    expect(h.size).toBe(2);
  });

  it("clears and validates the duration", () => {
    const h = new ScanHistory(100);
    h.add(0, scan);
    h.clear();
    expect(h.visible(0)).toEqual([]);
    expect(() => new ScanHistory(0)).toThrow(RangeError);
  });
});

describe("MotionDetector", () => {
  const zone = Z(3, 3);
  const at = (d: number, sigma = 10): RangingFrame =>
    frame({ distance: (z) => (z === zone ? d : 1000), sigma: (z) => (z === zone ? sigma : 10) });

  it("does not flag anything on the first frame", () => {
    const m = new MotionDetector();
    expect(m.update(at(500)).some(Boolean)).toBe(false);
    expect(m.backgroundOf(zone)).toBe(500);
  });

  it("flags a difference above the threshold (100 mm, exclusive)", () => {
    const m = new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 1 });
    m.update(at(1000));
    expect(m.update(at(1100))[zone]).toBe(false); // 差 100 はしきい値ちょうど
    expect(m.update(at(1201))[zone]).toBe(true); // 背景は 1100 に追従済み、差 101
    expect(m.update(at(1201))[zone]).toBe(false);
  });

  it("raises the threshold with sigma", () => {
    expect(DEFAULT_MOTION_OPTIONS.sigmaFactor).toBe(3);
    const m = new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 1 });
    m.update(at(1000, 40));
    expect(m.update(at(1120, 40))[zone]).toBe(false); // しきい値 max(100, 3 × 40) = 120
    const n = new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 1 });
    n.update(at(1000, 40));
    expect(n.update(at(1121, 40))[zone]).toBe(true);
    // sigma が小さければ 100 mm のまま
    const q = new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 1 });
    q.update(at(1000, 30));
    expect(q.update(at(1101, 30))[zone]).toBe(true);
  });

  it("follows the background slowly and eventually accepts a stopped object", () => {
    const m = new MotionDetector(); // 追従 0.05
    m.update(at(1000));
    expect(m.update(at(600))[zone]).toBe(true);
    expect(m.backgroundOf(zone)).toBeCloseTo(1000 - 400 * 0.05, 9);
    let frames = 1;
    while (m.update(at(600))[zone]) frames++;
    // 差が 100 以下になるまで: 400 × 0.95^n ≤ 100 → n ≥ 27.03
    expect(frames).toBe(28);
  });

  it("ignores invalid zones without touching their background", () => {
    const m = new MotionDetector();
    m.update(at(1000));
    const invalid = frame({
      distance: (z) => (z === zone ? 300 : 1000),
      status: (z) => (z === zone ? 6 : 5),
    });
    expect(m.update(invalid)[zone]).toBe(false);
    expect(m.backgroundOf(zone)).toBe(1000);
  });

  it("treats a zone without a target as empty and flags anything that appears there", () => {
    const m = new MotionDetector(); // 追従 0.05
    const empty = frame({ status: (z) => (z === zone ? 255 : 5) });
    m.update(empty);
    expect(m.isEmpty(zone)).toBe(true);
    // 空 → 有効: しきい値によらず「動いた」。背景は EMPTY_BACKGROUND_MM から追従し始める
    expect(m.update(at(3950))[zone]).toBe(true);
    expect(m.backgroundOf(zone)).toBeCloseTo(EMPTY_BACKGROUND_MM + (3950 - 4000) * 0.05, 9);
    expect(m.isEmpty(zone)).toBe(false);
    // その後は通常どおり(背景 3997.5 と 3950 の差は 47.5 でしきい値未満)
    expect(m.update(at(3950))[zone]).toBe(false);
  });

  it("keeps flagging an object that appeared in an empty zone until the background follows", () => {
    const m = new MotionDetector();
    m.update(frame({ status: (z) => (z === zone ? 255 : 5) }));
    let frames = 0;
    while (m.update(at(1000))[zone]) frames++;
    // 1 フレーム目は空からの出現、以後は 4000 から追従する背景との差が 100 以下になるまで:
    // 3000 × 0.95^n ≤ 100 → n ≥ 66.3
    expect(frames).toBe(67);
  });

  it("returns to empty when the target leaves, so that it is detected again", () => {
    const m = new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 1 });
    m.update(frame({ status: (z) => (z === zone ? 255 : 5) }));
    expect(m.update(at(800))[zone]).toBe(true); // 人が入った
    expect(m.update(at(800))[zone]).toBe(false); // 止まった(追従 1 なので背景 = 800)
    expect(m.update(frame({ status: (z) => (z === zone ? 255 : 5) }))[zone]).toBe(false); // 去った
    expect(m.isEmpty(zone)).toBe(true);
    expect(Number.isNaN(m.backgroundOf(zone))).toBe(true);
    expect(m.update(at(800))[zone]).toBe(true); // 同じ距離をもう一度通っても検出できる
  });

  it("also treats nb_target_detected = 0 as empty, but not other invalid states", () => {
    const m = new MotionDetector();
    const noTarget: RangingFrame = {
      ...at(1000),
      fields: {
        ...at(1000).fields,
        nb_target_detected: Uint8Array.from({ length: 64 }, (_, z) => (z === zone ? 0 : 1)),
      },
    };
    m.update(noTarget);
    expect(m.isEmpty(zone)).toBe(true);
    const n = new MotionDetector();
    n.update(at(1000));
    n.update(frame({ distance: () => 1000, status: (z) => (z === zone ? 6 : 5) }));
    expect(n.isEmpty(zone)).toBe(false); // ステータスが無効なだけでは空にしない
    expect(n.backgroundOf(zone)).toBe(1000);
  });

  it("uses the first target (t = 0) with T = 2", () => {
    const m = new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 1 });
    const f = (d0: number, d1: number, sigma0 = 10): RangingFrame =>
      frameT2({
        distance: (z, t) => (z === zone ? (t === 0 ? d0 : d1) : 1000),
        sigma: (z, t) => (z === zone && t === 0 ? sigma0 : 10),
      });
    m.update(f(1000, 3000));
    expect(m.update(f(1000, 500))[zone]).toBe(false); // ターゲット 1 だけが動いた
    expect(m.update(f(1150, 500))[zone]).toBe(true); // ターゲット 0 が 150 mm 動いた
    expect(m.backgroundOf(zone)).toBe(1150);
    // sigma もターゲット 0 のもの: 3 × 45 = 135 > 120 なので動きなし
    expect(m.update(f(1270, 500, 45))[zone]).toBe(false);
  });

  it("restarts when the targets per zone change", () => {
    const m = new MotionDetector();
    m.update(at(1000));
    const t2 = frameT2({ distance: (z) => (z === zone ? 300 : 1000) });
    expect(m.update(t2)[zone]).toBe(false); // 背景を作り直したので、1 フレーム目は判定しない
    expect(m.backgroundOf(zone)).toBe(300);
  });

  it("restarts on a resolution change and on reset", () => {
    const m = new MotionDetector();
    m.update(at(1000));
    expect(m.update(frame({ side: 4, distance: () => 300 })).some(Boolean)).toBe(false);
    m.reset();
    expect(Number.isNaN(m.backgroundOf(0))).toBe(true);
  });

  it("validates its options", () => {
    expect(() => new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 0 })).toThrow(
      RangeError,
    );
    expect(() => new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, followRate: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => new MotionDetector({ ...DEFAULT_MOTION_OPTIONS, thresholdMm: -1 })).toThrow(
      RangeError,
    );
  });
});

describe("ScanSimulator", () => {
  /** k 番目のフレーム: 全ゾーンの距離が 1000 + 10k、ステータスは k が偶数なら 5、奇数なら 9 */
  const nth = (k: number, side = 8): RangingFrame =>
    frame({ side, seq: k, distance: () => 1000 + 10 * k, status: () => (k % 2 === 0 ? 5 : 9) });

  it("waits until side frames are collected", () => {
    const s = new ScanSimulator();
    for (let k = 0; k < 7; k++) {
      expect(s.push(nth(k), H1V0)).toBeNull();
    }
    expect(s.push(nth(7), H1V0)).not.toBeNull();
  });

  it("takes the sensor's left column from the oldest frame and the right column from the latest", () => {
    const s = new ScanSimulator();
    let out: RangingFrame | null = null;
    for (let k = 0; k < 10; k++) out = s.push(nth(k), H1V0);
    if (out === null) throw new Error("no output");
    // 最後の 8 フレームは k = 2〜9。センサーから見た列 c は k = 2 + c
    for (let zone = 0; zone < 64; zone++) {
      const c = sensorColumn(zone, 8, H1V0);
      expect(out.fields.distance_mm?.[zone], `zone ${zone}`).toBe(1000 + 10 * (2 + c));
      expect(out.fields.target_status?.[zone]).toBe((2 + c) % 2 === 0 ? 5 : 9);
    }
    expect(out.seq).toBe(9);
  });

  it("follows the orientation (the sensor's left column is the front view's right)", () => {
    const s = new ScanSimulator();
    const o: Orientation = { flipH: false, flipV: false };
    let out: RangingFrame | null = null;
    for (let k = 0; k < 8; k++) out = s.push(nth(k), o);
    // 反転なしでは zone 0 は正面から見て左上 = センサーから見て右端 → 最新(k = 7)
    expect(out?.fields.distance_mm?.[0]).toBe(1070);
    expect(out?.fields.distance_mm?.[7]).toBe(1000);
  });

  it("restarts when the resolution changes and on reset", () => {
    const s = new ScanSimulator();
    for (let k = 0; k < 7; k++) s.push(nth(k), H1V0);
    expect(s.push(nth(7, 4), H1V0)).toBeNull(); // 4x4 に変わった: 1 フレーム目
    for (let k = 8; k < 10; k++) s.push(nth(k, 4), H1V0);
    expect(s.push(nth(10, 4), H1V0)).not.toBeNull(); // 4x4 は 4 フレームで出る
    s.reset();
    expect(s.push(nth(11, 4), H1V0)).toBeNull();
  });

  it("restarts when the targets per zone or the field mask change", () => {
    const s = new ScanSimulator();
    for (let k = 0; k < 7; k++) s.push(nth(k, 4), H1V0);
    // field_mask は同じ(0x0F)で、T だけが 2 に変わったフレーム
    const t2: RangingFrame = {
      ...nth(7, 4),
      targetsPerZone: 2,
      fields: {
        distance_mm: new Int16Array(32).fill(500),
        target_status: new Uint8Array(32).fill(5),
        range_sigma_mm: new Uint16Array(32).fill(10),
        nb_target_detected: new Uint8Array(16).fill(1),
      },
    };
    expect(t2.fieldMask).toBe(nth(0, 4).fieldMask);
    expect(s.push(t2, H1V0)).toBeNull(); // T が変わった: 1 フレーム目
    const u = new ScanSimulator();
    for (let k = 0; k < 7; k++) u.push(nth(k, 4), H1V0);
    const mask: RangingFrame = { ...nth(7, 4), fieldMask: 0x03 };
    expect(u.push(mask, H1V0)).toBeNull(); // フィールドが変わった: 1 フレーム目
  });

  it("copies per-target and per-zone fields with T = 2", () => {
    const f2 = (k: number): RangingFrame => ({
      type: "frame",
      seq: k,
      timestampUs: 0,
      side: 4,
      targetsPerZone: 2,
      fieldMask: 0x09,
      temperatureC: 0,
      fields: {
        distance_mm: Int16Array.from({ length: 32 }, (_, i) => k * 100 + (i % 2)),
        nb_target_detected: new Uint8Array(16).fill(k),
      },
    });
    const s = new ScanSimulator();
    let out: RangingFrame | null = null;
    for (let k = 1; k <= 4; k++) out = s.push(f2(k), H1V0);
    for (let zone = 0; zone < 16; zone++) {
      const k = 1 + sensorColumn(zone, 4, H1V0);
      expect(out?.fields.distance_mm?.[zone * 2]).toBe(k * 100);
      expect(out?.fields.distance_mm?.[zone * 2 + 1]).toBe(k * 100 + 1);
      expect(out?.fields.nb_target_detected?.[zone]).toBe(k);
    }
  });
});

describe("sweepAngleDeg (the scanning effect)", () => {
  it("goes back and forth across the field of view", () => {
    expect(sweepAngleDeg(0, 2000)).toBe(-22.5);
    expect(sweepAngleDeg(500, 2000)).toBe(0);
    expect(sweepAngleDeg(1000, 2000)).toBe(22.5);
    expect(sweepAngleDeg(1500, 2000)).toBe(0);
    expect(sweepAngleDeg(2000, 2000)).toBe(-22.5);
  });
});

describe("real capture (step3, 2026-09-27) through the LiDAR view", () => {
  const comma = captureDataUrl.indexOf(",");
  const capture = Uint8Array.from(atob(captureDataUrl.slice(comma + 1)), (c) => c.charCodeAt(0));
  const frames: RangingFrame[] = [];
  new Receiver(
    (m) => {
      if (m.type === "frame") frames.push(m);
    },
    () => 0,
  ).push(capture);

  it("gives a scan line in every direction with plausible distances", () => {
    expect(frames).toHaveLength(91);
    for (const f of frames) {
      const scan = scanLine(f, H1V0, "center");
      // 記録の値: 中央 2 行で全 8 方向に有効ゾーンがあり、距離は 328〜1218 mm
      expect(scan.every((s) => s.distanceMm !== null)).toBe(true);
      for (const s of scan) {
        expect(s.distanceMm).toBeGreaterThanOrEqual(300);
        expect(s.distanceMm).toBeLessThanOrEqual(4000);
      }
      // 全行の最近距離は中央 2 行以下
      const all = scanLine(f, H1V0, "all");
      for (const [i, s] of all.entries()) {
        expect(s.distanceMm ?? Infinity).toBeLessThanOrEqual(scan[i]?.distanceMm ?? Infinity);
      }
    }
  });

  it("flags only a few zones as moving", () => {
    const m = new MotionDetector();
    const counts = frames.map((f) => m.update(f).filter(Boolean).length);
    expect(counts[0]).toBe(0);
    // 記録の値: 1 フレームで最大 6 ゾーン(64 のうち)。大半のゾーンは止まっている
    expect(Math.max(...counts)).toBeLessThanOrEqual(10);
  });

  it("builds a simulated scan frame after 8 frames", () => {
    const s = new ScanSimulator();
    const outs = frames.map((f) => s.push(f, H1V0));
    expect(outs.slice(0, 7).every((o) => o === null)).toBe(true);
    expect(outs.slice(7).every((o) => o !== null)).toBe(true);
    const last = outs[outs.length - 1];
    const newest = frames[frames.length - 1];
    // センサーから見て右端の列は最新のフレームと同じ
    for (let zone = 0; zone < 64; zone++) {
      if (sensorColumn(zone, 8, H1V0) === 7) {
        expect(last?.fields.distance_mm?.[zone]).toBe(newest?.fields.distance_mm?.[zone]);
      }
    }
  });
});
