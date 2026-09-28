/**
 * 表示の計算(向き、ゾーンの有効判定、色の割り当て、自動レンジ、ゾーンの説明文)。
 * Canvas や DOM には依存しない(render.ts と main.ts が使う)。
 */

import type { RangingFrame } from "./frame.ts";

/** 距離の色の範囲の上限 [mm](Step 2 のターミナル表示と同じ 0〜2000 mm) */
export const DISTANCE_MAX_MM = 2000;

/** sigma の上限 [mm](Step 2 と同じ暫定値。超えたゾーンは無効として灰色にする) */
export const SIGMA_MAX_MM = 50;

/** 表示の向き */
export interface Orientation {
  /** 左右反転 */
  readonly flipH: boolean;
  /** 上下反転 */
  readonly flipV: boolean;
}

/**
 * 画面の (行, 列) に描くゾーンの番号を返す。
 * 反転なしなら zone = row × side + col。h=1 v=0 で、センサーを正面から見て 9 ピン列を左にした見た目になる
 * (docs/frame-format.md の「ゾーンと物理的な向き」)。
 *
 * @param row - 画面の行(0 = 上)
 * @param col - 画面の列(0 = 左)
 * @param side - 一辺のゾーン数
 * @param orientation - 反転
 */
export function zoneAt(row: number, col: number, side: number, orientation: Orientation): number {
  const r = orientation.flipV ? side - 1 - row : row;
  const c = orientation.flipH ? side - 1 - col : col;
  return r * side + c;
}

/**
 * ゾーンの状態。Step 2 と同じ順で判定する:
 * ターゲットなし(ターゲット数 0 またはステータス 255)→ ステータスが 5 / 9 以外 → sigma が上限超え。
 */
export type ZoneClass = "ok" | "none" | "status" | "sigma" | "nodata";

/**
 * ゾーンの最初のターゲット(t = 0)の状態を判定する。classifyTarget の target = 0。
 *
 * @param frame - 測距フレーム
 * @param zone - ゾーンの番号
 * @param sigmaMaxMm - sigma の上限 [mm]
 */
export function classifyZone(
  frame: RangingFrame,
  zone: number,
  sigmaMaxMm: number = SIGMA_MAX_MM,
): ZoneClass {
  return classifyTarget(frame, zone, 0, sigmaMaxMm);
}

/**
 * ゾーンの target 番目のターゲットの状態を判定する(添字は zone × T + target)。
 * 判定の順は classifyZone と同じ。ターゲット数(nb_target_detected)が target 以下なら、そのターゲットは
 * 検出されていないので `none`(target = 0 ならターゲット数 0 のとき)。
 * フレームに含まれないフィールドの検査は省く(距離がなければ `nodata`)。
 *
 * @param frame - 測距フレーム
 * @param zone - ゾーンの番号
 * @param target - ターゲットの番号(0 から)
 * @param sigmaMaxMm - sigma の上限 [mm]
 */
export function classifyTarget(
  frame: RangingFrame,
  zone: number,
  target: number,
  sigmaMaxMm: number = SIGMA_MAX_MM,
): ZoneClass {
  const f = frame.fields;
  const i = zone * frame.targetsPerZone + target;
  if (f.distance_mm?.[i] === undefined) {
    return "nodata";
  }
  const status = f.target_status?.[i];
  const detected = f.nb_target_detected?.[zone];
  if ((detected !== undefined && target >= detected) || status === 255) {
    return "none";
  }
  if (status !== undefined && status !== 5 && status !== 9) {
    return "status";
  }
  const sigma = f.range_sigma_mm?.[i];
  if (sigma !== undefined && sigma > sigmaMaxMm) {
    return "sigma";
  }
  return "ok";
}

/** 色(0〜255 の RGB) */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Rgb を CSS の色の文字列にする */
export function cssColor(c: Rgb): string {
  return `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`;
}

/** 無効なゾーンの色(灰色の濃淡で種類を分け、記号も重ねる) */
export const INVALID_COLORS: Readonly<Record<Exclude<ZoneClass, "ok">, Rgb>> = {
  none: { r: 58, g: 58, b: 56 },
  status: { r: 110, g: 110, b: 106 },
  sigma: { r: 150, g: 150, b: 145 },
  nodata: { r: 30, g: 30, b: 30 },
};

/** 無効なゾーンに重ねる記号(Step 2 のターミナル表示と同じ) */
export const INVALID_MARKS: Readonly<Record<Exclude<ZoneClass, "ok">, string>> = {
  none: "",
  status: "x",
  sigma: "?",
  nodata: "",
};

/** 範囲外(DISTANCE_MAX_MM 超)の色。暗い紫(Step 2 と同じ考え方。灰色・青と見分けられる) */
export const OUT_OF_RANGE_COLOR: Rgb = { r: 80, g: 20, b: 100 };

/** HSL(h: 度、s・l: 0〜1)を RGB にする */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number =>
    255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return { r: f(0), g: f(8), b: f(4) };
}

/**
 * 有効なゾーンの距離の色。近 = 赤 → 黄 → 緑 → 遠 = 青(色相 0〜240°を 0〜DISTANCE_MAX_MM に対応させる)。
 * DISTANCE_MAX_MM を超えたら OUT_OF_RANGE_COLOR、負の値は 0 として扱う。
 *
 * @param distanceMm - 距離 [mm]
 */
export function distanceColor(distanceMm: number): Rgb {
  if (distanceMm > DISTANCE_MAX_MM) {
    return OUT_OF_RANGE_COLOR;
  }
  const t = Math.max(0, distanceMm) / DISTANCE_MAX_MM;
  return hslToRgb(240 * t, 0.85, 0.5);
}

/** 値の範囲 */
export interface Range {
  readonly min: number;
  readonly max: number;
}

/**
 * 自動レンジ。フレームごとの最小・最大に追従する。広がるときはすぐに、狭まるときはゆっくり
 * (1 回あたり `shrink` の割合)追従して、フレームごとのちらつきを抑える。
 */
export class AutoRange {
  private current: Range | null = null;
  private readonly shrink: number;

  /**
   * @param shrink - 狭まるときに 1 回で近づく割合(0〜1。1 なら毎回そのフレームの範囲)
   */
  constructor(shrink = 0.1) {
    this.shrink = shrink;
  }

  /**
   * 新しいフレームの範囲で更新し、表示に使う範囲を返す。
   *
   * @param observed - このフレームの最小・最大(値がなければ null。そのときは前の範囲を返す)
   * @returns 表示に使う範囲(まだ一度も値がなければ null)
   */
  update(observed: Range | null): Range | null {
    if (observed === null) {
      return this.current;
    }
    if (this.current === null) {
      this.current = observed;
      return this.current;
    }
    const min =
      observed.min < this.current.min
        ? observed.min
        : this.current.min + (observed.min - this.current.min) * this.shrink;
    const max =
      observed.max > this.current.max
        ? observed.max
        : this.current.max + (observed.max - this.current.max) * this.shrink;
    this.current = { min, max };
    return this.current;
  }

  /** 範囲を忘れる */
  reset(): void {
    this.current = null;
  }
}

/**
 * ターゲットごとの配列(添字 zone × T + t)から、各ゾーンの最初のターゲット(t = 0)の値だけを取り出す。
 *
 * @param values - ターゲットごとの配列(長さ Z × T)
 * @param targetsPerZone - T(1 以上)
 * @returns 長さ ⌊values.length / T⌋ の配列。T = 1 なら values をそのまま返す
 * @throws RangeError targetsPerZone が 1 以上の整数でないとき
 */
export function firstTargets(values: Uint32Array, targetsPerZone: number): Uint32Array {
  if (!Number.isInteger(targetsPerZone) || targetsPerZone < 1) {
    throw new RangeError(`targetsPerZone must be a positive integer: ${targetsPerZone}`);
  }
  if (targetsPerZone === 1) {
    return values;
  }
  const out = new Uint32Array(Math.floor(values.length / targetsPerZone));
  for (let z = 0; z < out.length; z++) {
    out[z] = values[z * targetsPerZone] ?? 0;
  }
  return out;
}

/**
 * 配列の最小・最大を返す。`filter` を満たす値だけを対象にする。
 *
 * @returns 対象の値がなければ null
 */
export function minMax(
  values: Iterable<number>,
  filter: (v: number) => boolean = () => true,
): Range | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!filter(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { min, max } : null;
}

/**
 * 対数スケールでの位置(0〜1)。値が 0 以下なら 0。範囲の幅が 0 なら範囲内を 1 とする。
 *
 * @param value - 値(正)
 * @param range - 範囲(min > 0)
 */
export function logPosition(value: number, range: Range): number {
  if (value <= 0 || range.min <= 0) {
    return 0;
  }
  const lo = Math.log10(range.min);
  const hi = Math.log10(range.max);
  if (hi <= lo) {
    return value >= range.min ? 1 : 0;
  }
  return clamp01((Math.log10(value) - lo) / (hi - lo));
}

/**
 * 線形スケールでの位置(0〜1)。範囲の幅が 0 なら範囲内を 1 とする。
 */
export function linearPosition(value: number, range: Range): number {
  if (range.max <= range.min) {
    return value >= range.min ? 1 : 0;
  }
  return clamp01((value - range.min) / (range.max - range.min));
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** グレースケール(0 = 黒、1 = 白) */
export function grayColor(position: number): Rgb {
  const v = 255 * clamp01(position);
  return { r: v, g: v, b: v };
}

/** 青の単色ランプ(0 = 暗い青、1 = 明るい青)。暗い背景の上で量の大小を表す */
const BLUE_RAMP: readonly Rgb[] = [
  { r: 0x0d, g: 0x36, b: 0x6b },
  { r: 0x18, g: 0x4f, b: 0x95 },
  { r: 0x25, g: 0x6a, b: 0xbf },
  { r: 0x39, g: 0x87, b: 0xe5 },
  { r: 0x6d, g: 0xa7, b: 0xec },
  { r: 0x9e, g: 0xc5, b: 0xf4 },
  { r: 0xcd, g: 0xe2, b: 0xfb },
];

/** 青の単色ランプの色(0〜1) */
export function blueRampColor(position: number): Rgb {
  const x = clamp01(position) * (BLUE_RAMP.length - 1);
  const i = Math.min(Math.floor(x), BLUE_RAMP.length - 2);
  const a = BLUE_RAMP[i];
  const b = BLUE_RAMP[i + 1];
  if (a === undefined || b === undefined) {
    return BLUE_RAMP[0] ?? { r: 0, g: 0, b: 0 };
  }
  const t = x - i;
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

const ZONE_CLASS_LABELS: Readonly<Record<ZoneClass, string>> = {
  ok: "有効",
  none: "ターゲットなし",
  status: "ステータスが無効",
  sigma: `sigma が上限(${SIGMA_MAX_MM} mm)超え`,
  nodata: "距離なし",
};

/**
 * ゾーンの全フィールドの値を、表示用の行の列にする。
 *
 * @param frame - 測距フレーム
 * @param zone - ゾーンの番号(0〜side²−1)
 * @returns 表示する行。zone が範囲外なら空
 */
export function describeZone(frame: RangingFrame, zone: number): string[] {
  const zones = frame.side * frame.side;
  if (!Number.isInteger(zone) || zone < 0 || zone >= zones) {
    return [];
  }
  const f = frame.fields;
  const row = Math.floor(zone / frame.side);
  const col = zone % frame.side;
  const lines = [
    `zone ${zone}(row ${row}, col ${col}): ${ZONE_CLASS_LABELS[classifyZone(frame, zone)]}`,
  ];
  const nbTarget = f.nb_target_detected?.[zone];
  if (nbTarget !== undefined) lines.push(`nb_target_detected: ${nbTarget}`);
  const spads = f.nb_spads_enabled?.[zone];
  if (spads !== undefined) lines.push(`nb_spads_enabled: ${spads}`);
  for (let t = 0; t < frame.targetsPerZone; t++) {
    const i = zone * frame.targetsPerZone + t;
    const parts: string[] = [];
    const d = f.distance_mm?.[i];
    if (d !== undefined) parts.push(`distance ${d} mm`);
    const s = f.target_status?.[i];
    if (s !== undefined) parts.push(`status ${s}`);
    const sigma = f.range_sigma_mm?.[i];
    if (sigma !== undefined) parts.push(`sigma ${sigma} mm`);
    const signal = f.signal_per_spad?.[i];
    if (signal !== undefined) parts.push(`signal ${signal} kcps/SPAD`);
    if (parts.length > 0) {
      lines.push(`target ${t}: ${parts.join(", ")}`);
    }
  }
  return lines;
}

/** 3D の点・パッチの色に使う値 */
export type ColorBy = "distance" | "signal" | "spads";

/** 自動レンジの範囲(signal と SPAD 数。まだ値がなければ null) */
export interface ColorRanges {
  readonly signal: Range | null;
  readonly spads: Range | null;
}

/**
 * ゾーンの値の色(2D 画像と同じ色の関数)。距離は distanceColor、signal_per_spad は対数・自動レンジのグレースケール、
 * nb_spads_enabled は線形・自動レンジの青のランプ。ゾーンの有効・無効は見ない(呼び出し側で決める)。
 * 距離と signal_per_spad は target 番目のターゲットの値を使う。nb_spads_enabled はゾーンごとの値なので target によらない。
 *
 * @param frame - 測距フレーム
 * @param zone - ゾーンの番号
 * @param by - 色に使う値
 * @param ranges - signal と SPAD 数の表示範囲
 * @param target - ターゲットの番号(0 から。既定は最初のターゲット)
 * @returns 色。フィールドがない・範囲がまだないときは null
 */
export function zoneValueColor(
  frame: RangingFrame,
  zone: number,
  by: ColorBy,
  ranges: ColorRanges,
  target = 0,
): Rgb | null {
  const f = frame.fields;
  const i = zone * frame.targetsPerZone + target;
  switch (by) {
    case "distance": {
      const d = f.distance_mm?.[i];
      return d === undefined ? null : distanceColor(d);
    }
    case "signal": {
      const v = f.signal_per_spad?.[i];
      return v === undefined || ranges.signal === null
        ? null
        : grayColor(logPosition(v, ranges.signal));
    }
    case "spads": {
      const v = f.nb_spads_enabled?.[zone];
      return v === undefined || ranges.spads === null
        ? null
        : blueRampColor(linearPosition(v, ranges.spads));
    }
  }
}
