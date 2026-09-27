/**
 * ToF の幾何: ゾーン → 方向の角度 → 3D の位置。DOM / three.js に依存しない。
 *
 * **仮定(ST の資料で未確認)**:
 * - 画角は各軸 45°(水平・垂直とも ±22.5°)を採用。ST / Pololu の公称は「45° × 45°、対角 65°」だが、
 *   このモデル(方向 (tan ax, tan ay, 1))では対角は約 60.7° になり、公称の対角 65° と同時には成り立たない。
 *   画角の定義(各軸の値か、どこで測った値か)は未確認
 * - ゾーンの中心は角度で等間隔(8x8 なら 45 / 8 = 5.625° ごと)。tan で等間隔(平面上で等間隔)の可能性もある
 * - 距離の定義は「垂直距離」(センサー面からの距離)か「半径」(視線方向の距離)か未確認。ULD の changelog に
 *   "rad2perp coefficients" があり、センサー内で半径 → 垂直距離に変換している手がかりはあるが、確かめていない。
 *   そのため両方の解釈で位置を計算できるようにし、正面の平らな壁がどちらで平面になるかを実機で確かめる
 *
 * **座標系(センサー座標)**: センサーから外を見て、x = 右、y = 上、z = 前方(距離の方向)。単位は mm。
 * この 3 軸は左手系(x × y が z ではなく −z になる)。three.js(右手系)で描くときは sensorToWorld で
 * z の符号を反転して前方を −z にする。これは基底の取り替え(前方の向きを −z と呼び直す)で、鏡像にはならない。
 * センサー座標のまま右手系の three.js に入れると、センサーの後ろから見た 3D の左右が鏡像になる。
 *
 * **2D 画像との関係**: 2D 画像は「センサーを正面から見た図」(9 ピン列を左にして持つと zone 0 が右上)。
 * センサーから外を見ると左右が逆になるので、2D 画像の右上にある zone 0 は、センサー座標では左上(x < 0、y > 0)にある。
 */

import type { RangingFrame } from "./frame.ts";
import { classifyZone, type Orientation, type ZoneClass } from "./view.ts";

/** 画角(水平・垂直とも)[度] */
export const FOV_DEG = 45;

/** 距離の解釈 */
export type DistanceModel =
  /** 垂直距離: センサー面からの距離(z = d) */
  | "perpendicular"
  /** 半径: 視線方向の距離(原点からの長さ = d) */
  | "radial";

/** センサー座標の点 [mm] */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * センサー座標 [mm] を three.js の世界座標 [m](右手系、y が上)に写す: (x, y, −z) / 1000。
 * 右 → +x、上 → +y、前方 → −z(three.js のカメラが見る向き)。右 × 上 = +z = 前方の逆(カメラの後方)で右手系になる。
 *
 * @param v - センサー座標 [mm]
 * @returns three.js の世界座標 [m]
 */
export function sensorToWorld(v: Vec3): Vec3 {
  return { x: v.x / 1000, y: v.y / 1000, z: -v.z / 1000 };
}

/** 方向の角度 [度]。ax はセンサーから見て右が正、ay は上が正 */
export interface Angles {
  readonly ax: number;
  readonly ay: number;
}

const DEG = Math.PI / 180;

function assertSide(side: number): void {
  if (side !== 4 && side !== 8) {
    throw new RangeError(`side must be 4 or 8: ${side}`);
  }
}

/**
 * ゾーンの角度のピッチ [度](8x8 で 5.625°、4x4 で 11.25°)。
 *
 * @throws RangeError side が 4 / 8 でないとき
 */
export function zonePitchDeg(side: number): number {
  assertSide(side);
  return FOV_DEG / side;
}

/**
 * ゾーンを「センサーを正面から見た図」(2D 画像)のどの行・列に描くかを返す。view.ts の zoneAt の逆。
 * orientation は 2D 画像が正面から見た見た目と一致する反転(状態メッセージの h / v。確定値は h=1 v=0)。
 *
 * @param zone - ゾーンの番号(0〜side²−1)
 * @throws RangeError zone や side が範囲外のとき
 */
export function zoneGridPosition(
  zone: number,
  side: number,
  orientation: Orientation,
): { row: number; col: number } {
  assertSide(side);
  if (!Number.isInteger(zone) || zone < 0 || zone >= side * side) {
    throw new RangeError(`zone out of range: ${zone}`);
  }
  const r = Math.floor(zone / side);
  const c = zone % side;
  return {
    row: orientation.flipV ? side - 1 - r : r,
    col: orientation.flipH ? side - 1 - c : c,
  };
}

/**
 * ゾーンの中心の方向の角度 [度](角度で等間隔の仮定)。
 * 正面から見た図の列が右へ進むほど、センサーから見ると左(ax が負)になる。
 *
 * @throws RangeError zone や side が範囲外のとき
 */
export function zoneAnglesDeg(zone: number, side: number, orientation: Orientation): Angles {
  const { row, col } = zoneGridPosition(zone, side, orientation);
  const pitch = zonePitchDeg(side);
  const mid = (side - 1) / 2;
  return { ax: (mid - col) * pitch, ay: (mid - row) * pitch };
}

/**
 * 方向の角度と距離から点を求める。角度は x 方向・y 方向それぞれの z 軸からの傾き
 * (方向ベクトルは (tan ax, tan ay, 1) に比例)。
 *
 * @param angles - 方向の角度 [度](±90° 未満)
 * @param distanceMm - 距離 [mm]
 * @param model - 距離の解釈
 */
export function pointAt(angles: Angles, distanceMm: number, model: DistanceModel): Vec3 {
  const tx = Math.tan(angles.ax * DEG);
  const ty = Math.tan(angles.ay * DEG);
  if (model === "perpendicular") {
    return { x: distanceMm * tx, y: distanceMm * ty, z: distanceMm };
  }
  const k = distanceMm / Math.hypot(tx, ty, 1);
  return { x: k * tx, y: k * ty, z: k };
}

/**
 * ゾーンの中心の点。
 *
 * @throws RangeError zone や side が範囲外のとき
 */
export function zoneCenter(
  zone: number,
  side: number,
  orientation: Orientation,
  distanceMm: number,
  model: DistanceModel,
): Vec3 {
  return pointAt(zoneAnglesDeg(zone, side, orientation), distanceMm, model);
}

/**
 * ゾーンが受け持つ四角錐の、距離 d での断面の 4 隅(ゾーンの「広がり」)。
 * 並びはセンサーから見て 左下 → 右下 → 右上 → 左上。隣のゾーンと同じ距離なら、隅が一致する。
 *
 * @throws RangeError zone や side が範囲外のとき
 */
export function zonePatch(
  zone: number,
  side: number,
  orientation: Orientation,
  distanceMm: number,
  model: DistanceModel,
): [Vec3, Vec3, Vec3, Vec3] {
  const c = zoneAnglesDeg(zone, side, orientation);
  const h = zonePitchDeg(side) / 2;
  const at = (dx: number, dy: number): Vec3 =>
    pointAt({ ax: c.ax + dx, ay: c.ay + dy }, distanceMm, model);
  return [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
}

/**
 * 視野の四角錐の、距離 d での断面の 4 隅(左下 → 右下 → 右上 → 左上)。
 */
export function frustumCorners(distanceMm: number, model: DistanceModel): [Vec3, Vec3, Vec3, Vec3] {
  const h = FOV_DEG / 2;
  const at = (ax: number, ay: number): Vec3 => pointAt({ ax, ay }, distanceMm, model);
  return [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
}

/** 点群の 1 点 */
export interface CloudPoint {
  readonly zone: number;
  /** ゾーンの状態(view.ts の classifyZone。ok 以外は無効) */
  readonly cls: ZoneClass;
  /** 最初のターゲット(t = 0)の距離 [mm] */
  readonly distanceMm: number;
  /** センサー座標の位置 [mm] */
  readonly position: Vec3;
}

/**
 * 測距フレームから点群を作る。各ゾーンの最初のターゲット(t = 0)を使う。
 * 距離のフィールドがなければ空。距離が 0 以下のゾーン(ターゲットなし等で値が意味を持たない)は含めない。
 * 無効なゾーンも cls 付きで含める(表示するかは呼び出し側が決める)。
 *
 * @param frame - 測距フレーム
 * @param orientation - 2D 画像が正面から見た見た目と一致する反転
 * @param model - 距離の解釈
 */
export function buildPointCloud(
  frame: RangingFrame,
  orientation: Orientation,
  model: DistanceModel,
): CloudPoint[] {
  const distances = frame.fields.distance_mm;
  if (distances === undefined) {
    return [];
  }
  const points: CloudPoint[] = [];
  const zones = frame.side * frame.side;
  for (let zone = 0; zone < zones; zone++) {
    const d = distances[zone * frame.targetsPerZone];
    if (d === undefined || d <= 0) {
      continue;
    }
    points.push({
      zone,
      cls: classifyZone(frame, zone),
      distanceMm: d,
      position: zoneCenter(zone, frame.side, orientation, d, model),
    });
  }
  return points;
}
