import { describe, expect, it } from "vitest";
import { cobsEncode } from "../src/cobs.ts";
import { crc32 } from "../src/crc32.ts";
import { decodeSerialPacket, type RangingFrame } from "../src/frame.ts";
import {
  FOV_DEG,
  buildPointCloud,
  frustumCorners,
  pointAt,
  sensorToWorld,
  zoneAnglesDeg,
  zoneCenter,
  zoneGridPosition,
  zonePatch,
  zonePitchDeg,
  type Vec3,
} from "../src/geometry.ts";
import { Receiver } from "../src/receiver.ts";
import { zoneAt, type Orientation } from "../src/view.ts";
import { concat, vectors } from "./vectors.ts";
import captureDataUrl from "./fixtures/step3_cap_20260927.bin?inline";

const H1V0: Orientation = { flipH: true, flipV: false };
const ORIENTATIONS: Orientation[] = [
  { flipH: false, flipV: false },
  { flipH: true, flipV: false },
  { flipH: false, flipV: true },
  { flipH: true, flipV: true },
];
const TAN = (deg: number): number => Math.tan((deg * Math.PI) / 180);

function expectVecClose(a: Vec3, b: Vec3, digits = 6): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

describe("zone angles", () => {
  it("uses a pitch of 45 / side degrees", () => {
    expect(FOV_DEG).toBe(45);
    expect(zonePitchDeg(8)).toBe(5.625);
    expect(zonePitchDeg(4)).toBe(11.25);
    expect(() => zonePitchDeg(6)).toThrow(RangeError);
  });

  it("puts the corner zones at ±(45/2 − pitch/2) degrees", () => {
    for (const side of [4, 8]) {
      const edge = FOV_DEG / 2 - zonePitchDeg(side) / 2; // 8x8: 19.6875°、4x4: 16.875°
      const angles = Array.from({ length: side * side }, (_, z) => zoneAnglesDeg(z, side, H1V0));
      expect(Math.max(...angles.map((a) => a.ax))).toBeCloseTo(edge, 12);
      expect(Math.min(...angles.map((a) => a.ax))).toBeCloseTo(-edge, 12);
      expect(Math.max(...angles.map((a) => a.ay))).toBeCloseTo(edge, 12);
      expect(Math.min(...angles.map((a) => a.ay))).toBeCloseTo(-edge, 12);
    }
    expect(FOV_DEG / 2 - zonePitchDeg(8) / 2).toBe(19.6875);
  });

  it("puts the four central zones symmetrically around the axis", () => {
    for (const side of [4, 8]) {
      const m = side / 2;
      const central = [(m - 1) * side + m - 1, (m - 1) * side + m, m * side + m - 1, m * side + m];
      const pts = central.map((z) => zoneCenter(z, side, H1V0, 1000, "perpendicular"));
      const sum = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), {
        x: 0,
        y: 0,
        z: 0,
      });
      expect(sum.x).toBeCloseTo(0, 9);
      expect(sum.y).toBeCloseTo(0, 9);
      for (const p of pts) {
        expect(Math.abs(p.x)).toBeCloseTo(1000 * TAN(zonePitchDeg(side) / 2), 9);
        expect(Math.abs(p.y)).toBeCloseTo(1000 * TAN(zonePitchDeg(side) / 2), 9);
      }
    }
  });

  it("spaces neighboring zones by one pitch", () => {
    const a = zoneAnglesDeg(0, 8, H1V0);
    const right = zoneAnglesDeg(1, 8, H1V0); // 正面から見て zone 0 の左隣 = センサーから見て右隣
    const below = zoneAnglesDeg(8, 8, H1V0);
    expect(right.ax - a.ax).toBeCloseTo(5.625, 12);
    expect(right.ay).toBe(a.ay);
    expect(a.ay - below.ay).toBeCloseTo(5.625, 12);
  });
});

describe("orientation and zone 0", () => {
  it("inverts zoneAt for every orientation and size", () => {
    for (const side of [4, 8]) {
      for (const o of ORIENTATIONS) {
        for (let z = 0; z < side * side; z++) {
          const { row, col } = zoneGridPosition(z, side, o);
          expect(zoneAt(row, col, side, o)).toBe(z);
        }
      }
    }
  });

  it("h=1 v=0: zone 0 is top-right in the front view and top-left as seen from the sensor", () => {
    expect(zoneGridPosition(0, 8, H1V0)).toEqual({ row: 0, col: 7 });
    const a = zoneAnglesDeg(0, 8, H1V0);
    expect(a.ax).toBeCloseTo(-19.6875, 12); // センサーから見て左(x < 0)
    expect(a.ay).toBeCloseTo(19.6875, 12); // 上
    const p = zoneCenter(0, 8, H1V0, 1000, "perpendicular");
    expect(p.x).toBeLessThan(0);
    expect(p.y).toBeGreaterThan(0);
    // 正面から見て左上に描くゾーン(zone 7)は、センサーから見て右上(x > 0)
    expect(zoneCenter(7, 8, H1V0, 1000, "perpendicular").x).toBeGreaterThan(0);
  });

  it("follows the flip flags of the status message", () => {
    const status = vectors.messages.find((m) => m.name === "status");
    if (status === undefined) throw new Error("status vector not found");
    for (const [flags, sx, sy] of [
      [0, 1, 1],
      [1, -1, 1],
      [2, 1, -1],
      [3, -1, -1],
    ] as const) {
      const p = status.payload.slice();
      p[17] = flags;
      const crc = new Uint8Array(4);
      new DataView(crc.buffer).setUint32(0, crc32(p), true);
      const r = decodeSerialPacket(cobsEncode(concat(p, crc)));
      if (!r.ok || r.message.type !== "status") throw new Error("rejected");
      const a = zoneAnglesDeg(0, 8, r.message);
      expect([Math.sign(a.ax), Math.sign(a.ay)], `flags ${flags}`).toEqual([sx, sy]);
    }
  });

  it("rejects out-of-range zones and sides", () => {
    expect(() => zoneGridPosition(64, 8, H1V0)).toThrow(RangeError);
    expect(() => zoneGridPosition(-1, 8, H1V0)).toThrow(RangeError);
    expect(() => zoneGridPosition(16, 4, H1V0)).toThrow(RangeError);
    expect(() => zoneGridPosition(0.5, 8, H1V0)).toThrow(RangeError);
    expect(() => zoneGridPosition(0, 5, H1V0)).toThrow(RangeError);
  });
});

describe("distance models", () => {
  it("perpendicular keeps z = d and radial keeps |p| = d", () => {
    for (const z of [0, 9, 27, 63]) {
      const perp = zoneCenter(z, 8, H1V0, 1500, "perpendicular");
      const rad = zoneCenter(z, 8, H1V0, 1500, "radial");
      expect(perp.z).toBeCloseTo(1500, 9);
      expect(Math.hypot(rad.x, rad.y, rad.z)).toBeCloseTo(1500, 9);
      // 同じ方向
      expect(rad.x / rad.z).toBeCloseTo(perp.x / perp.z, 12);
      expect(rad.y / rad.z).toBeCloseTo(perp.y / perp.z, 12);
    }
  });

  it("differs in z by the cosine of the off-axis angle", () => {
    for (const z of [0, 27, 36, 63]) {
      const a = zoneAnglesDeg(z, 8, H1V0);
      const cos = 1 / Math.hypot(TAN(a.ax), TAN(a.ay), 1);
      const perp = zoneCenter(z, 8, H1V0, 1000, "perpendicular");
      const rad = zoneCenter(z, 8, H1V0, 1000, "radial");
      expect(rad.z / perp.z).toBeCloseTo(cos, 12);
    }
  });

  it("gives a ratio of about 1.121 at the center of the corner zone (points)", () => {
    // 点の表示で隅のゾーンの中心(±19.6875°)。壁の実験で点を見るときの最大の差(約 12%)
    const corner = zoneAnglesDeg(0, 8, H1V0);
    const perp = pointAt(corner, 1000, "perpendicular");
    expect(Math.hypot(perp.x, perp.y, perp.z) / 1000).toBeCloseTo(1.121, 3);
  });

  it("has a diagonal field of view of about 60.7 degrees (not the nominal 65)", () => {
    const [bl, , tr] = frustumCorners(1000, "perpendicular");
    const dot = bl.x * tr.x + bl.y * tr.y + bl.z * tr.z;
    const deg =
      (Math.acos(dot / (Math.hypot(bl.x, bl.y, bl.z) * Math.hypot(tr.x, tr.y, tr.z))) * 180) /
      Math.PI;
    expect(deg).toBeCloseTo(60.7, 1);
  });

  it("gives a ratio of about 1.159 at the outer corner of the patches (±22.5°)", () => {
    const perp = pointAt({ ax: 22.5, ay: 22.5 }, 1000, "perpendicular");
    expect(Math.hypot(perp.x, perp.y, perp.z) / 1000).toBeCloseTo(1.159, 3);
  });

  it("maps a flat wall at z = d to equal z only in the perpendicular model", () => {
    const perpZ = Array.from(
      { length: 64 },
      (_, z) => zoneCenter(z, 8, H1V0, 800, "perpendicular").z,
    );
    expect(new Set(perpZ.map((v) => v.toFixed(9)))).toEqual(new Set(["800.000000000"]));
    const radZ = Array.from({ length: 64 }, (_, z) => zoneCenter(z, 8, H1V0, 800, "radial").z);
    expect(Math.min(...radZ)).toBeLessThan(800 * 0.9);
  });

  it("scales linearly with the distance", () => {
    const a = zoneCenter(10, 8, H1V0, 500, "radial");
    const b = zoneCenter(10, 8, H1V0, 1000, "radial");
    expectVecClose({ x: a.x * 2, y: a.y * 2, z: a.z * 2 }, b);
  });
});

describe("zone patches", () => {
  for (const side of [4, 8]) {
    for (const model of ["perpendicular", "radial"] as const) {
      it(`touch their neighbors at the same distance (${side}x${side}, ${model})`, () => {
        for (const o of ORIENTATIONS) {
          for (let z = 0; z < side * side; z++) {
            const { row, col } = zoneGridPosition(z, side, o);
            const p = zonePatch(z, side, o, 1234, model);
            // 正面から見て右隣(列 + 1)= センサーから見て左隣。自分の左辺(左下・左上)が隣の右辺(右下・右上)と一致
            if (col + 1 < side) {
              const q = zonePatch(zoneAt(row, col + 1, side, o), side, o, 1234, model);
              expectVecClose(p[0], q[1]);
              expectVecClose(p[3], q[2]);
            }
            // 下隣(行 + 1): 自分の下辺(左下・右下)が隣の上辺(左上・右上)と一致
            if (row + 1 < side) {
              const q = zonePatch(zoneAt(row + 1, col, side, o), side, o, 1234, model);
              expectVecClose(p[0], q[3]);
              expectVecClose(p[1], q[2]);
            }
          }
        }
      });
    }
  }

  it("contains the zone center and grows with the distance", () => {
    const [bl, br, tr, tl] = zonePatch(20, 8, H1V0, 1000, "perpendicular");
    const c = zoneCenter(20, 8, H1V0, 1000, "perpendicular");
    expect(bl.x).toBeLessThan(c.x);
    expect(br.x).toBeGreaterThan(c.x);
    expect(tr.y).toBeGreaterThan(c.y);
    expect(bl.y).toBeLessThan(c.y);
    expect(tl.x).toBeCloseTo(bl.x, 9);
    const far = zonePatch(20, 8, H1V0, 2000, "perpendicular");
    expect(far[1].x - far[0].x).toBeCloseTo(2 * (br.x - bl.x), 9);
  });

  it("covers the whole field of view with the outer corners", () => {
    const fov = frustumCorners(1000, "perpendicular");
    // 8x8、h=1 v=0: センサーから見て左下の隅は、正面から見た図の右下(行 7、列 7)のゾーン
    const bottomLeftZone = zoneAt(7, 7, 8, H1V0);
    expectVecClose(zonePatch(bottomLeftZone, 8, H1V0, 1000, "perpendicular")[0], fov[0]);
    expect(fov[2].x).toBeCloseTo(1000 * TAN(22.5), 9);
    expect(fov[2].y).toBeCloseTo(1000 * TAN(22.5), 9);
  });
});

describe("point cloud", () => {
  function frame4(distances: number[], status: number[]): RangingFrame {
    return {
      type: "frame",
      seq: 0,
      timestampUs: 0,
      side: 4,
      targetsPerZone: 1,
      fieldMask: 0x03,
      temperatureC: 0,
      fields: { distance_mm: Int16Array.from(distances), target_status: Uint8Array.from(status) },
    };
  }

  it("skips non-positive distances and classifies the rest", () => {
    const d = Array.from({ length: 16 }, (_, i) => (i === 3 ? 0 : i === 4 ? -5 : 1000));
    const s = Array.from({ length: 16 }, (_, i) => (i === 5 ? 6 : i === 6 ? 255 : 5));
    const cloud = buildPointCloud(frame4(d, s), H1V0, "perpendicular");
    expect(cloud.map((p) => p.zone)).toEqual([0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(cloud.find((p) => p.zone === 5)?.cls).toBe("status");
    expect(cloud.find((p) => p.zone === 6)?.cls).toBe("none");
    expect(cloud.find((p) => p.zone === 0)?.cls).toBe("ok");
    expect(cloud[0]?.position).toEqual(zoneCenter(0, 4, H1V0, 1000, "perpendicular"));
  });

  it("uses the first target when T > 1", () => {
    const f: RangingFrame = {
      ...frame4([], []),
      targetsPerZone: 2,
      fields: {
        distance_mm: Int16Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 500 : 3000)),
      },
    };
    const cloud = buildPointCloud(f, H1V0, "perpendicular");
    expect(cloud).toHaveLength(16);
    expect(cloud.every((p) => p.distanceMm === 500)).toBe(true);
  });

  it("is empty without distances", () => {
    expect(buildPointCloud({ ...frame4([], []), fields: {} }, H1V0, "radial")).toEqual([]);
    expect(buildPointCloud({ ...frame4([], []), fields: {} }, H1V0, "radial", "detected")).toEqual(
      [],
    );
  });
});

describe("point cloud with all detected targets", () => {
  // T = 2、4x4。t0 は 500 mm、t1 は 3000 mm。ステータスは既定で 5
  function frameT2(fields: Partial<RangingFrame["fields"]>): RangingFrame {
    return {
      type: "frame",
      seq: 0,
      timestampUs: 0,
      side: 4,
      targetsPerZone: 2,
      fieldMask: 0x0b,
      temperatureC: 0,
      fields: {
        distance_mm: Int16Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 500 : 3000)),
        target_status: new Uint8Array(32).fill(5),
        ...fields,
      },
    };
  }
  const summary = (cloud: ReturnType<typeof buildPointCloud>) =>
    cloud.map((p) => `${p.zone}.${p.target}:${p.distanceMm}:${p.cls}`);

  it("draws the targets up to nb_target_detected, and always the first", () => {
    const detected = [2, 1, 0];
    const f = frameT2({
      nb_target_detected: Uint8Array.from({ length: 16 }, (_, z) => detected[z] ?? 1),
    });
    const cloud = buildPointCloud(f, H1V0, "perpendicular", "detected");
    // zone 0: 2 つ、zone 1: 1 つ、zone 2: 検出 0 でも t0 を無効(none)の点として返す、以降 1 つずつ
    expect(summary(cloud).slice(0, 4)).toEqual([
      "0.0:500:ok",
      "0.1:3000:ok",
      "1.0:500:ok",
      "2.0:500:none",
    ]);
    expect(cloud).toHaveLength(17);
    const far = cloud.find((p) => p.zone === 0 && p.target === 1);
    expect(far?.position).toEqual(zoneCenter(0, 4, H1V0, 3000, "perpendicular"));
  });

  it("uses all T targets without nb_target_detected, skipping non-positive distances", () => {
    const d = Int16Array.from({ length: 32 }, (_, i) =>
      i === 3 ? 0 : i === 5 ? -1 : i % 2 === 0 ? 500 : 3000,
    );
    const cloud = buildPointCloud(frameT2({ distance_mm: d }), H1V0, "perpendicular", "detected");
    // zone 1 と zone 2 の t1(添字 3 と 5)は距離 0 以下なので除く
    expect(cloud).toHaveLength(30);
    expect(cloud.filter((p) => p.zone === 1).map((p) => p.target)).toEqual([0]);
    expect(cloud.filter((p) => p.zone === 2).map((p) => p.target)).toEqual([0]);
  });

  it("classifies each target separately", () => {
    const status = new Uint8Array(32).fill(5);
    status[0] = 6; // zone 0 の t0 は無効、t1 は有効
    status[3] = 13; // zone 1 の t1 は無効
    const cloud = buildPointCloud(
      frameT2({ target_status: status, nb_target_detected: new Uint8Array(16).fill(2) }),
      H1V0,
      "perpendicular",
      "detected",
    );
    expect(summary(cloud).slice(0, 4)).toEqual([
      "0.0:500:status",
      "0.1:3000:ok",
      "1.0:500:ok",
      "1.1:3000:status",
    ]);
  });

  it("never reads past T even if nb_target_detected is larger", () => {
    // ULD からは来ない値だが、T を超えて読むと次のゾーンの t0 を読んでしまう
    const f = frameT2({ nb_target_detected: new Uint8Array(16).fill(4) });
    const cloud = buildPointCloud(f, H1V0, "perpendicular", "detected");
    expect(cloud).toHaveLength(32);
    expect(cloud.filter((p) => p.zone === 0).map((p) => p.distanceMm)).toEqual([500, 3000]);
  });

  it("keeps the first-target cloud unchanged", () => {
    const f = frameT2({ nb_target_detected: new Uint8Array(16).fill(2) });
    const first = buildPointCloud(f, H1V0, "perpendicular");
    expect(first).toHaveLength(16);
    expect(first.every((p) => p.target === 0 && p.distanceMm === 500)).toBe(true);
  });
});

describe("point cloud from the real capture (step3, 2026-09-27)", () => {
  const comma = captureDataUrl.indexOf(",");
  const capture = Uint8Array.from(atob(captureDataUrl.slice(comma + 1)), (c) => c.charCodeAt(0));
  const frames: RangingFrame[] = [];
  new Receiver(
    (m) => {
      if (m.type === "frame") frames.push(m);
    },
    () => 0,
  ).push(capture);

  it("has 91 frames with most zones valid", () => {
    expect(frames).toHaveLength(91);
    for (const f of frames) {
      const cloud = buildPointCloud(f, H1V0, "perpendicular");
      const valid = cloud.filter((p) => p.cls === "ok");
      // 記録の値: 1 フレームの有効ゾーンは 60〜64
      expect(valid.length).toBeGreaterThanOrEqual(60);
      expect(cloud.length).toBeLessThanOrEqual(64);
    }
  });

  it("keeps every valid point inside the field of view and the sensor's range", () => {
    const limit = TAN(FOV_DEG / 2);
    for (const model of ["perpendicular", "radial"] as const) {
      for (const f of frames) {
        for (const p of buildPointCloud(f, H1V0, model)) {
          if (p.cls !== "ok") continue;
          const { x, y, z } = p.position;
          // 記録の有効な距離は 325〜2321 mm。VL53L8CX の最大測距距離は 4 m
          expect(z).toBeGreaterThan(0);
          expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(4000 * 1.2);
          expect(Math.abs(x)).toBeLessThanOrEqual(z * limit + 1e-9);
          expect(Math.abs(y)).toBeLessThanOrEqual(z * limit + 1e-9);
        }
      }
    }
  });

  it("gives the same cloud with all detected targets when T = 1", () => {
    for (const f of frames) {
      expect(buildPointCloud(f, H1V0, "perpendicular", "detected")).toEqual(
        buildPointCloud(f, H1V0, "perpendicular"),
      );
    }
  });

  it("keeps the distance of each point under both models", () => {
    const f = frames[45];
    if (f === undefined) throw new Error("frame missing");
    const perp = buildPointCloud(f, H1V0, "perpendicular");
    const rad = buildPointCloud(f, H1V0, "radial");
    expect(perp.map((p) => p.zone)).toEqual(rad.map((p) => p.zone));
    for (const [i, p] of perp.entries()) {
      const q = rad[i];
      if (q === undefined) throw new Error("missing");
      expect(p.position.z).toBeCloseTo(p.distanceMm, 9);
      expect(Math.hypot(q.position.x, q.position.y, q.position.z)).toBeCloseTo(q.distanceMm, 9);
    }
  });
});

describe("sensorToWorld", () => {
  const cross = (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const forward = sensorToWorld({ x: 0, y: 0, z: 1000 });
  const right = sensorToWorld({ x: 1000, y: 0, z: 0 });
  const up = sensorToWorld({ x: 0, y: 1000, z: 0 });

  it("maps right, up and forward to +x, +y and −z in meters", () => {
    expectVecClose(right, { x: 1, y: 0, z: 0 });
    expectVecClose(up, { x: 0, y: 1, z: 0 });
    expectVecClose(forward, { x: 0, y: 0, z: -1 });
  });

  it("makes a right-handed basis: right × up = −forward (the camera's back, +z)", () => {
    const c = cross(right, up);
    expectVecClose(c, { x: -forward.x, y: -forward.y, z: -forward.z });
    expectVecClose(c, { x: 0, y: 0, z: 1 });
  });

  it("keeps a point on the sensor's right on +x after the mapping", () => {
    // h=1 v=0 で正面から見た図の左端の列(センサーから見て右)のゾーンは、世界座標でも +x
    const z = zoneAt(3, 0, 8, H1V0);
    expect(sensorToWorld(zoneCenter(z, 8, H1V0, 1000, "perpendicular")).x).toBeGreaterThan(0);
  });
});
