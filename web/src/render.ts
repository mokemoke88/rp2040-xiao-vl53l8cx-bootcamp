/**
 * Canvas 2D による 8x8(または 4x4)画像と凡例の描画。値の計算は view.ts、状態は main.ts が持つ。
 */

import type { RangingFrame } from "./frame.ts";
import {
  DISTANCE_MAX_MM,
  INVALID_COLORS,
  INVALID_MARKS,
  OUT_OF_RANGE_COLOR,
  blueRampColor,
  classifyZone,
  cssColor,
  distanceColor,
  grayColor,
  linearPosition,
  logPosition,
  zoneAt,
  type Orientation,
  type Range,
  type Rgb,
} from "./view.ts";

/** 画像の一辺 [CSS px] */
export const GRID_PX = 320;
/** 凡例の高さ [CSS px] */
export const LEGEND_PX = 64;
/** セルの間の隙間 [CSS px] */
const GAP_PX = 2;

const SURFACE = "#1a1a19";
const TEXT_PRIMARY = "#ffffff";
const TEXT_SECONDARY = "#c3c2b7";
const HOVER_OUTLINE = "#ffffff";

/**
 * 8x8 画像の canvas の大きさを決め、devicePixelRatio と倍率に合わせて描画の解像度を上げる。
 * 描画の座標は倍率によらず GRID_PX 基準(一辺 320)のままで、ctx の変換で拡大する(全画面で大きく描くため)。
 * 呼ぶたびに canvas の中身と ctx の状態は消える(描き直しが要る)。
 *
 * @param scale - 表示の倍率(1 = 一辺 GRID_PX [CSS px])
 * @returns 描画コンテキスト(座標は GRID_PX 基準)
 * @throws Error 2D コンテキストを得られないとき
 */
export function setupCanvas(canvas: HTMLCanvasElement, scale = 1): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${GRID_PX * scale}px`;
  canvas.style.height = `${(GRID_PX + LEGEND_PX) * scale}px`;
  canvas.width = Math.round(GRID_PX * dpr * scale);
  canvas.height = Math.round((GRID_PX + LEGEND_PX) * dpr * scale);
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Canvas 2D is not available");
  }
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  return ctx;
}

/**
 * 任意の大きさの canvas(LiDAR 風ビューなど)を CSS px で決め、devicePixelRatio に合わせる。
 * 呼ぶたびに canvas の中身と ctx の状態は消える。
 *
 * @returns 描画コンテキスト(座標は CSS px)
 * @throws Error 2D コンテキストを得られないとき
 */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Canvas 2D is not available");
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * canvas 上の位置(CSS px、canvas の左上が原点)から画面の (行, 列) を求める。
 *
 * @returns 画像の外なら null
 */
export function cellFromPoint(
  x: number,
  y: number,
  side: number,
): { row: number; col: number } | null {
  if (x < 0 || y < 0 || x >= GRID_PX || y >= GRID_PX) {
    return null;
  }
  const cell = GRID_PX / side;
  return { row: Math.floor(y / cell), col: Math.floor(x / cell) };
}

/** 1 つのセルの見た目 */
interface Cell {
  readonly color: Rgb;
  readonly text: string;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  side: number,
  orientation: Orientation,
  hoverZone: number | null,
  cellOf: (zone: number) => Cell,
): void {
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, GRID_PX, GRID_PX);
  const cell = GRID_PX / side;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${side === 8 ? 12 : 16}px system-ui, sans-serif`;
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const zone = zoneAt(row, col, side, orientation);
      const { color, text } = cellOf(zone);
      const x = col * cell + GAP_PX / 2;
      const y = row * cell + GAP_PX / 2;
      const w = cell - GAP_PX;
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(x, y, w, w);
      if (text !== "") {
        // 背景の明るさに合わせて文字色を選ぶ(相対輝度の簡易式)
        const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
        ctx.fillStyle = luma > 140 ? "#000000" : TEXT_PRIMARY;
        ctx.fillText(text, x + w / 2, y + w / 2);
      }
      if (zone === hoverZone) {
        ctx.strokeStyle = HOVER_OUTLINE;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, w - 2);
      }
    }
  }
}

function drawNoData(ctx: CanvasRenderingContext2D, message: string): void {
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, GRID_PX, GRID_PX + LEGEND_PX);
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillText(message, GRID_PX / 2, GRID_PX / 2);
}

/** 距離の凡例の色(0〜1 を 0〜DISTANCE_MAX_MM に対応させる。キャッシュのキーになるので定数にしておく) */
const distanceLegendColor = (t: number): Rgb => distanceColor(t * DISTANCE_MAX_MM);

/** 凡例の帯のグラデーションの色の刻み数(区間ごとに線形補間される) */
const LEGEND_STOPS = 32;

/** 凡例の帯のグラデーションのキャッシュ(コンテキストごと・色の関数ごと。帯の位置と色は変わらない) */
const legendGradients = new WeakMap<
  CanvasRenderingContext2D,
  Map<(t: number) => Rgb, CanvasGradient>
>();

function legendGradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  colorAt: (t: number) => Rgb,
): CanvasGradient {
  let byColor = legendGradients.get(ctx);
  if (byColor === undefined) {
    byColor = new Map();
    legendGradients.set(ctx, byColor);
  }
  let gradient = byColor.get(colorAt);
  if (gradient === undefined) {
    gradient = ctx.createLinearGradient(x, 0, x + width, 0);
    for (let i = 0; i <= LEGEND_STOPS; i++) {
      gradient.addColorStop(i / LEGEND_STOPS, cssColor(colorAt(i / LEGEND_STOPS)));
    }
    byColor.set(colorAt, gradient);
  }
  return gradient;
}

/**
 * 凡例の帯(左端 0 → 右端 1)と、その下の目盛り。
 * colorAt は同じ関数オブジェクトを渡すこと(グラデーションを関数ごとにキャッシュするため)
 */
function drawLegendBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  colorAt: (t: number) => Rgb,
  ticks: readonly { readonly t: number; readonly label: string }[],
  title: string,
): void {
  const top = GRID_PX + 8;
  const barH = 12;
  ctx.fillStyle = legendGradient(ctx, x, width, colorAt);
  ctx.fillRect(x, top, width, barH);
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "top";
  for (const tick of ticks) {
    ctx.textAlign = tick.t <= 0 ? "left" : tick.t >= 1 ? "right" : "center";
    ctx.fillText(tick.label, x + tick.t * width, top + barH + 3);
  }
  ctx.textAlign = "left";
  ctx.fillText(title, 0, top + barH + 20);
}

function drawSwatch(ctx: CanvasRenderingContext2D, x: number, color: Rgb, label: string): void {
  const top = GRID_PX + 8;
  ctx.fillStyle = cssColor(color);
  ctx.fillRect(x, top, 12, 12);
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(label, x + 15, top);
}

function clearLegend(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, GRID_PX, GRID_PX, LEGEND_PX);
}

/**
 * 距離のヒートマップ。有効なゾーンは近 = 赤 → 遠 = 青、範囲外は暗い紫、無効は灰色(記号 x = ステータス、? = sigma)。
 *
 * @param showNumbers - true なら有効なゾーンに距離 [mm] を重ねる
 */
export function drawDistanceImage(
  ctx: CanvasRenderingContext2D,
  frame: RangingFrame | null,
  orientation: Orientation,
  hoverZone: number | null,
  showNumbers: boolean,
): void {
  const distances = frame?.fields.distance_mm;
  if (frame === null || distances === undefined) {
    drawNoData(ctx, frame === null ? "フレーム待ち" : "距離のフィールドなし");
    return;
  }
  drawGrid(ctx, frame.side, orientation, hoverZone, (zone) => {
    const cls = classifyZone(frame, zone);
    if (cls !== "ok") {
      return { color: INVALID_COLORS[cls], text: INVALID_MARKS[cls] };
    }
    const d = distances[zone * frame.targetsPerZone] ?? 0;
    return { color: distanceColor(d), text: showNumbers ? String(d) : "" };
  });
  clearLegend(ctx);
  const barW = 180;
  drawLegendBar(
    ctx,
    0,
    barW,
    distanceLegendColor,
    [
      { t: 0, label: "0" },
      { t: 0.5, label: "1000" },
      { t: 1, label: `${DISTANCE_MAX_MM}` },
    ],
    "距離 [mm](近 → 遠)",
  );
  drawSwatch(ctx, barW + 12, OUT_OF_RANGE_COLOR, `>${DISTANCE_MAX_MM}`);
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("灰: 無効 x=status ?=sigma", barW + 12, GRID_PX + 26);
}

/**
 * signal_per_spad の「IR 画像」。対数スケール・自動レンジのグレースケール(黒 = 弱い、白 = 強い)。
 * 無効なゾーンも値のまま描く(値は信号の強さなので、距離が無効でも意味を持つ)。
 *
 * @param range - 表示の範囲 [kcps/SPAD](null なら範囲なし。すべて黒)
 */
export function drawSignalImage(
  ctx: CanvasRenderingContext2D,
  frame: RangingFrame | null,
  orientation: Orientation,
  hoverZone: number | null,
  range: Range | null,
): void {
  const signal = frame?.fields.signal_per_spad;
  if (frame === null || signal === undefined) {
    drawNoData(ctx, frame === null ? "フレーム待ち" : "signal_per_spad のフィールドなし");
    return;
  }
  drawGrid(ctx, frame.side, orientation, hoverZone, (zone) => {
    const v = signal[zone * frame.targetsPerZone] ?? 0;
    return { color: grayColor(range === null ? 0 : logPosition(v, range)), text: "" };
  });
  clearLegend(ctx);
  drawLegendBar(
    ctx,
    0,
    GRID_PX,
    grayColor,
    range === null
      ? []
      : [
          { t: 0, label: formatValue(range.min) },
          { t: 1, label: formatValue(range.max) },
        ],
    "signal_per_spad [kcps/SPAD](対数、自動レンジ。0 は黒)",
  );
}

/**
 * nb_spads_enabled。線形・自動レンジの青の単色ランプ(暗い = 少ない、明るい = 多い)。
 *
 * @param range - 表示の範囲 [個](null なら範囲なし)
 */
export function drawSpadImage(
  ctx: CanvasRenderingContext2D,
  frame: RangingFrame | null,
  orientation: Orientation,
  hoverZone: number | null,
  range: Range | null,
): void {
  const spads = frame?.fields.nb_spads_enabled;
  if (frame === null || spads === undefined) {
    drawNoData(ctx, frame === null ? "フレーム待ち" : "nb_spads_enabled のフィールドなし");
    return;
  }
  drawGrid(ctx, frame.side, orientation, hoverZone, (zone) => {
    const v = spads[zone] ?? 0;
    return { color: blueRampColor(range === null ? 0 : linearPosition(v, range)), text: "" };
  });
  clearLegend(ctx);
  drawLegendBar(
    ctx,
    0,
    GRID_PX,
    blueRampColor,
    range === null
      ? []
      : [
          { t: 0, label: formatValue(range.min) },
          { t: 1, label: formatValue(range.max) },
        ],
    "nb_spads_enabled [個](線形、自動レンジ)",
  );
}

function formatValue(v: number): string {
  return Math.round(v).toString();
}
