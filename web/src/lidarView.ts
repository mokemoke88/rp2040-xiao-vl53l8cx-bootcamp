/**
 * LiDAR 風ビュー(真上から見た扇形)の Canvas 2D 描画。計算は scan2d.ts、状態は main.ts が持つ。
 * 座標は CSS px(呼び出し側が devicePixelRatio の変換を ctx に入れておく)。
 */

import { FOV_DEG } from "./geometry.ts";
import type { HistoryEntry, ScanPoint, TopPoint } from "./scan2d.ts";
import { cssColor, distanceColor } from "./view.ts";

/** 描くもの */
export interface TopViewData {
  /** 全ゾーンの点(無効なゾーンは描かない) */
  readonly points: readonly TopPoint[];
  /** スキャン線(null なら描かない) */
  readonly scan: readonly ScanPoint[] | null;
  /** 残像(古い順、不透明度付き) */
  readonly history: readonly { readonly entry: HistoryEntry; readonly alpha: number }[];
  /** ゾーンごとの「動いた」(null なら強調しない) */
  readonly moving: readonly boolean[] | null;
  /** 表示する最大距離 [mm] */
  readonly maxRangeMm: number;
  /** 走査の演出のビームの角度 [度](null なら描かない) */
  readonly sweepAngleDeg: number | null;
  /** 左上に出す注記(null なら出さない) */
  readonly label: string | null;
  /** 点の色: 距離の色か、単色か */
  readonly pointColor: "distance" | "plain";
}

const SURFACE = "#1a1a19";
const FAN_FILL = "#222220";
const GRID = "#3a3a37";
const TEXT_SECONDARY = "#c3c2b7";
const SCAN = "#7fe0ff";
const MOVING = "#ff9f1c";
const SWEEP = "rgba(127, 224, 255, 0.55)";
const RING_STEP_MM = 500;
const HALF_FOV_RAD = ((FOV_DEG / 2) * Math.PI) / 180;

/** 真上から見た図の座標変換 */
interface Frame2D {
  readonly cx: number;
  readonly cy: number;
  /** [px / mm] */
  readonly scale: number;
}

function layout(width: number, height: number, maxRangeMm: number): Frame2D {
  const top = 28;
  const bottom = 24;
  const scaleByHeight = (height - top - bottom) / maxRangeMm;
  // 扇の横幅は最大距離の円弧で ±sin(22.5°) ぶん。目盛りの文字の余白を少し取る
  const scaleByWidth = (width / 2 - 40) / (maxRangeMm * Math.sin(HALF_FOV_RAD));
  return {
    cx: width / 2,
    cy: height - bottom,
    scale: Math.max(0.001, Math.min(scaleByHeight, scaleByWidth)),
  };
}

function toScreen(f: Frame2D, x: number, z: number): [number, number] {
  return [f.cx + x * f.scale, f.cy - z * f.scale];
}

/** 画面の上方向から時計回りの角度(ラジアン)の方向の、半径 r [mm] の点 */
function polar(f: Frame2D, angleRad: number, r: number): [number, number] {
  return [f.cx + Math.sin(angleRad) * r * f.scale, f.cy - Math.cos(angleRad) * r * f.scale];
}

/**
 * 真上から見た扇形の図を描く。センサーは下の中央、上が前方、右がセンサーから見て右。
 *
 * @param ctx - 描画先(CSS px の座標)
 * @param width - 幅 [CSS px]
 * @param height - 高さ [CSS px]
 * @param data - 描くもの
 */
export function drawTopView(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: TopViewData,
): void {
  const f = layout(width, height, data.maxRangeMm);
  ctx.save();
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, width, height);

  // 視野の扇(canvas の arc は x 軸から時計回りなので、上方向 = −π/2 を基準にする)
  ctx.fillStyle = FAN_FILL;
  ctx.beginPath();
  ctx.moveTo(f.cx, f.cy);
  ctx.arc(
    f.cx,
    f.cy,
    data.maxRangeMm * f.scale,
    -Math.PI / 2 - HALF_FOV_RAD,
    -Math.PI / 2 + HALF_FOV_RAD,
  );
  ctx.closePath();
  ctx.fill();

  // 距離の輪と目盛り
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let r = RING_STEP_MM; r <= data.maxRangeMm; r += RING_STEP_MM) {
    ctx.beginPath();
    ctx.arc(f.cx, f.cy, r * f.scale, -Math.PI / 2 - HALF_FOV_RAD, -Math.PI / 2 + HALF_FOV_RAD);
    ctx.stroke();
    const [lx, ly] = polar(f, HALF_FOV_RAD, r);
    ctx.textAlign = "left";
    // 扇の右の辺の外側、輪の端の少し下に置く(最大距離の輪で角度の目盛りと重ならないように)
    ctx.fillText(`${(r / 1000).toFixed(1)} m`, lx + 6, ly + 8);
  }
  // 角度の目盛り(0°、±11.25°、±22.5°)
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const deg of [-22.5, -11.25, 0, 11.25, 22.5]) {
    const a = (deg * Math.PI) / 180;
    const [ex, ey] = polar(f, a, data.maxRangeMm);
    ctx.beginPath();
    ctx.moveTo(f.cx, f.cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.fillText(`${deg}°`, ex, ey - 2);
  }

  // 走査の演出のビーム
  if (data.sweepAngleDeg !== null) {
    const [bx, by] = polar(f, (data.sweepAngleDeg * Math.PI) / 180, data.maxRangeMm);
    ctx.strokeStyle = SWEEP;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(f.cx, f.cy);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // 全ゾーンの点(暗く)。動いたゾーンは橙で大きく
  for (const p of data.points) {
    if (p.cls !== "ok" || p.z > data.maxRangeMm) continue;
    const [sx, sy] = toScreen(f, p.x, p.z);
    const moving = data.moving?.[p.zone] === true;
    ctx.globalAlpha = moving ? 1 : 0.45;
    ctx.fillStyle = moving
      ? MOVING
      : data.pointColor === "distance"
        ? cssColor(distanceColor(p.distanceMm))
        : TEXT_SECONDARY;
    ctx.beginPath();
    ctx.arc(sx, sy, moving ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 残像(古いほど薄く)
  ctx.strokeStyle = SCAN;
  ctx.lineWidth = 1.5;
  for (const { entry, alpha } of data.history) {
    ctx.globalAlpha = alpha * 0.4;
    strokeScan(ctx, f, entry.scan, data.maxRangeMm);
  }
  ctx.globalAlpha = 1;

  // スキャン線(明るく)
  if (data.scan !== null) {
    ctx.strokeStyle = SCAN;
    ctx.lineWidth = 2.5;
    strokeScan(ctx, f, data.scan, data.maxRangeMm);
    ctx.fillStyle = SCAN;
    for (const s of data.scan) {
      if (s.x === null || s.z === null || s.z > data.maxRangeMm) continue;
      const [sx, sy] = toScreen(f, s.x, s.z);
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // センサー
  ctx.fillStyle = "#cccccc";
  ctx.fillRect(f.cx - 6, f.cy - 3, 12, 6);

  if (data.label !== null) {
    ctx.fillStyle = MOVING;
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(data.label, 8, 6);
  }
  ctx.restore();
}

/** スキャン線を折れ線で描く(距離のない方向・範囲外で線を切る) */
function strokeScan(
  ctx: CanvasRenderingContext2D,
  f: Frame2D,
  scan: readonly ScanPoint[],
  maxRangeMm: number,
): void {
  ctx.beginPath();
  let drawing = false;
  for (const s of scan) {
    if (s.x === null || s.z === null || s.z > maxRangeMm) {
      drawing = false;
      continue;
    }
    const [sx, sy] = toScreen(f, s.x, s.z);
    if (drawing) {
      ctx.lineTo(sx, sy);
    } else {
      ctx.moveTo(sx, sy);
      drawing = true;
    }
  }
  ctx.stroke();
}

/**
 * 走査の演出のビームの角度 [度]。視野の端から端を往復する(周期 periodMs)。
 *
 * @param nowMs - 現在時刻 [ms]
 * @param periodMs - 往復の周期 [ms]
 */
export function sweepAngleDeg(nowMs: number, periodMs = 2000): number {
  const phase = (nowMs % periodMs) / periodMs; // 0〜1
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2; // 0 → 1 → 0
  return -FOV_DEG / 2 + tri * FOV_DEG;
}
