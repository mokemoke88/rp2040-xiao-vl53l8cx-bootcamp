import { describe, expect, it } from "vitest";
import type { RangingFrame } from "../src/frame.ts";
import { PICK_RADIUS_PX, pickNearestPoint, toScreen, topViewLayout } from "../src/lidarView.ts";
import { ScanSimulator, scanLagFrames, sensorColumn, type TopPoint } from "../src/scan2d.ts";
import { DEVICE_LOST_DETAIL, isDeviceLost } from "../src/serial.ts";
import { TOOLTIP_OFFSET_PX, placeTooltip, tooltipLines } from "../src/tooltip.ts";
import { describeZone, type Orientation } from "../src/view.ts";

const H1V0: Orientation = { flipH: true, flipV: false };

function point(zone: number, x: number, z: number, cls: TopPoint["cls"] = "ok"): TopPoint {
  return { zone, row: 0, sensorCol: 0, cls, distanceMm: z, x, z };
}

describe("topViewLayout and toScreen", () => {
  it("puts the sensor at the bottom center and the front upward", () => {
    const f = topViewLayout(640, 400, 3000);
    expect(toScreen(f, 0, 0)).toEqual([320, 400 - 24]);
    const [, yFar] = toScreen(f, 0, 3000);
    expect(yFar).toBeCloseTo(28, 9); // 上の余白
    const [xRight] = toScreen(f, 100, 1000);
    expect(xRight).toBeGreaterThan(320); // センサーから見て右は画面の右
  });
});

describe("pickNearestPoint", () => {
  const f = topViewLayout(640, 400, 3000);
  const pts = [point(1, 0, 1000), point(2, 50, 1000), point(3, 0, 2000)];
  const at = (x: number, z: number): [number, number] => toScreen(f, x, z);

  it("picks the nearest drawn point", () => {
    const [px, py] = at(0, 1000);
    expect(pickNearestPoint(pts, f, px, py, 3000)?.zone).toBe(1);
    const [qx, qy] = at(45, 1000);
    expect(pickNearestPoint(pts, f, qx, qy, 3000)?.zone).toBe(2);
  });

  it("returns null beyond the radius and accepts the radius itself", () => {
    expect(PICK_RADIUS_PX).toBe(12); // 画面と docs/usage.md の説明(12 px 以内)と同じ値
    const [px, py] = at(0, 2000);
    expect(pickNearestPoint(pts, f, px + PICK_RADIUS_PX, py, 3000)?.zone).toBe(3);
    expect(pickNearestPoint(pts, f, px + PICK_RADIUS_PX + 0.5, py, 3000)).toBeNull();
    expect(pickNearestPoint(pts, f, px + 5, py, 3000, 4)).toBeNull();
  });

  it("ignores invalid points and points beyond the displayed range", () => {
    const [px, py] = at(0, 1000);
    const invalid = [point(7, 0, 1000, "status"), point(8, 0, 1000, "none")];
    expect(pickNearestPoint(invalid, f, px, py, 3000)).toBeNull();
    const far = [point(9, 0, 2500)];
    const [fx, fy] = at(0, 2500);
    expect(pickNearestPoint(far, f, fx, fy, 3000)?.zone).toBe(9);
    expect(pickNearestPoint(far, f, fx, fy, 2000)).toBeNull();
  });

  it("keeps the first point on a tie", () => {
    const [px, py] = at(0, 1000);
    const twins = [point(4, 0, 1000), point(5, 0, 1000)];
    expect(pickNearestPoint(twins, f, px, py, 3000)?.zone).toBe(4);
  });
});

describe("scanLagFrames and ScanSimulator.sourceSeqs", () => {
  it("gives side − 1 frames for the sensor's left column and 0 for the right", () => {
    for (let zone = 0; zone < 64; zone++) {
      expect(scanLagFrames(zone, 8, H1V0)).toBe(7 - sensorColumn(zone, 8, H1V0));
    }
    expect(scanLagFrames(0, 8, H1V0)).toBe(7); // zone 0 はセンサーから見て左端
    expect(scanLagFrames(0, 8, { flipH: false, flipV: false })).toBe(0);
  });

  it("reports the seq of the frame used for each sensor column", () => {
    const frame = (seq: number, side = 4): RangingFrame => ({
      type: "frame",
      seq,
      timestampUs: 0,
      side,
      targetsPerZone: 1,
      fieldMask: 0x01,
      temperatureC: 0,
      fields: { distance_mm: new Int16Array(side * side).fill(seq) },
    });
    const s = new ScanSimulator();
    s.push(frame(10), H1V0);
    expect(s.sourceSeqs).toEqual([]); // まだ合成していない
    s.push(frame(11), H1V0);
    s.push(frame(13), H1V0); // seq が飛んでも、実際のフレームの seq を返す
    const out = s.push(frame(14), H1V0);
    expect(s.sourceSeqs).toEqual([10, 11, 13, 14]);
    // 合成フレームの各ゾーンの値は、sourceSeqs の同じ列のフレームのもの
    for (let zone = 0; zone < 16; zone++) {
      const lag = scanLagFrames(zone, 4, H1V0);
      expect(out?.fields.distance_mm?.[zone]).toBe(s.sourceSeqs[3 - lag]);
    }
    s.push(frame(15, 8), H1V0); // 解像度が変わった
    expect(s.sourceSeqs).toEqual([]);
  });
});

describe("placeTooltip", () => {
  const o = TOOLTIP_OFFSET_PX;

  it("puts the tooltip at the lower right of the cursor", () => {
    expect(placeTooltip(100, 100, 200, 80, 1280, 800)).toEqual({ left: 100 + o, top: 100 + o });
  });

  it("flips to the left and above near the right and bottom edges", () => {
    expect(placeTooltip(1200, 100, 200, 80, 1280, 800)).toEqual({
      left: 1200 - o - 200,
      top: 100 + o,
    });
    expect(placeTooltip(100, 760, 200, 80, 1280, 800)).toEqual({
      left: 100 + o,
      top: 760 - o - 80,
    });
  });

  it("keeps it on screen at the boundary and when it is too large", () => {
    // ちょうど右端 − 4 px に収まる場合は反転しない
    expect(placeTooltip(1280 - 4 - 200 - o, 0, 200, 80, 1280, 800).left).toBe(1280 - 4 - 200);
    expect(placeTooltip(1280 - 4 - 200 - o + 1, 0, 200, 80, 1280, 800).left).toBe(
      1280 - 4 - 200 - o + 1 - o - 200,
    );
    expect(placeTooltip(50, 50, 2000, 1000, 1280, 800)).toEqual({ left: 4, top: 4 });
  });
});

describe("tooltipLines", () => {
  const frame: RangingFrame = {
    type: "frame",
    seq: 0,
    timestampUs: 0,
    side: 4,
    targetsPerZone: 1,
    fieldMask: 0x03,
    temperatureC: 0,
    fields: {
      distance_mm: new Int16Array(16).fill(800),
      target_status: new Uint8Array(16).fill(5),
    },
  };

  it("starts with the title, then the zone's fields, then the extra lines", () => {
    expect(tooltipLines("2D 画像: 距離", frame, 3, ["補足"])).toEqual([
      "2D 画像: 距離",
      ...describeZone(frame, 3),
      "補足",
    ]);
    expect(tooltipLines("模擬", null, 3, ["補足"])).toEqual(["模擬", "フレーム待ち"]);
  });
});

describe("isDeviceLost", () => {
  it("recognizes the NetworkError of a lost device only", () => {
    expect(isDeviceLost(new DOMException("The device has been lost.", "NetworkError"))).toBe(true);
    expect(isDeviceLost(new DOMException("Buffer overrun", "BufferOverrunError"))).toBe(false);
    expect(isDeviceLost(new Error("NetworkError"))).toBe(false);
    expect(DEVICE_LOST_DETAIL).toContain("USB");
  });
});
