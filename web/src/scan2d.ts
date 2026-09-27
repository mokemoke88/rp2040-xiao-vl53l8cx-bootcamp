/**
 * LiDAR 風ビュー(真上から見た図)の計算。DOM に依存しない(Vitest でテストする)。
 *
 * - 真上からの投影: 各ゾーンを (x, z) に置く(x = センサーから見て右、z = 前方。mm)。距離は垂直距離
 *   (Step 4 の壁の実験で確認)として geometry.ts の位置を使う
 * - スキャン線: センサーから見た列ごとに、選んだ行の帯の有効ゾーンの最近距離を取る(2D LiDAR の 1 回転ぶんに相当)
 * - 残像: 直近のスキャン線を時刻付きで持ち、古いほど薄くする
 * - 動きの強調: ゾーンごとに距離の遅い移動平均(背景)を持ち、背景との差がしきい値を超えたゾーンを「動いた」とする
 * - 走査型の模擬: 列ごとに違う時刻のフレームから取った合成フレーム(このセンサーは走査していない。見せるための模擬)
 */

import { FIELD_SPECS, type FrameFields, type RangingFrame } from "./frame.ts";
import {
  buildPointCloud,
  pointAt,
  zoneAnglesDeg,
  zoneGridPosition,
  type DistanceModel,
} from "./geometry.ts";
import { classifyZone, zoneAt, type Orientation, type ZoneClass } from "./view.ts";

/** 真上から見た 1 ゾーン */
export interface TopPoint {
  readonly zone: number;
  /** 正面から見た図(2D 画像)での行 */
  readonly row: number;
  /** センサーから見た列(0 = センサーから見て左端) */
  readonly sensorCol: number;
  readonly cls: ZoneClass;
  readonly distanceMm: number;
  /** センサーから見て右 [mm] */
  readonly x: number;
  /** 前方 [mm] */
  readonly z: number;
}

/**
 * センサーから見た列(0 = 左端)。正面から見た図の列とは左右が逆。
 *
 * @throws RangeError zone や side が範囲外のとき
 */
export function sensorColumn(zone: number, side: number, orientation: Orientation): number {
  return side - 1 - zoneGridPosition(zone, side, orientation).col;
}

/**
 * 測距フレームの各ゾーンを真上から見た位置にする。距離が 0 以下のゾーンは含めない(geometry.ts と同じ)。
 *
 * @param model - 距離の解釈(LiDAR 風ビューは垂直距離。レクチャーの対比で半径も使う)
 */
export function projectTop(
  frame: RangingFrame,
  orientation: Orientation,
  model: DistanceModel = "perpendicular",
): TopPoint[] {
  return buildPointCloud(frame, orientation, model).map((p) => ({
    zone: p.zone,
    row: zoneGridPosition(p.zone, frame.side, orientation).row,
    sensorCol: sensorColumn(p.zone, frame.side, orientation),
    cls: p.cls,
    distanceMm: p.distanceMm,
    x: p.position.x,
    z: p.position.z,
  }));
}

/** スキャン線に使う行の帯 */
export type RowBand =
  /** 全行 */
  | "all"
  /** 中央 2 行(水平面の断面に近い) */
  | "center";

/**
 * 帯に含まれる行(正面から見た図の行。上下はセンサーから見ても同じ)。
 *
 * @throws RangeError side が 2 未満の偶数でないとき
 */
export function bandRows(side: number, band: RowBand): number[] {
  if (!Number.isInteger(side) || side < 2 || side % 2 !== 0) {
    throw new RangeError(`side must be an even integer >= 2: ${side}`);
  }
  if (band === "center") {
    return [side / 2 - 1, side / 2];
  }
  return Array.from({ length: side }, (_, i) => i);
}

/** スキャン線の 1 方向 */
export interface ScanPoint {
  /** センサーから見た列(0 = 左端) */
  readonly sensorCol: number;
  /** 水平方向の角度 [度](センサーから見て右が正) */
  readonly angleDeg: number;
  /** 帯の中の有効ゾーンの最近距離 [mm](有効ゾーンがなければ null) */
  readonly distanceMm: number | null;
  /** 真上から見た位置 [mm](distanceMm が null なら null) */
  readonly x: number | null;
  readonly z: number | null;
}

/**
 * スキャン線: センサーから見た列ごと(左 → 右)に、帯の行の有効ゾーン(classifyZone が ok)の最近距離を取る。
 *
 * @param frame - 測距フレーム
 * @param orientation - 2D 画像が正面から見た見た目と一致する反転
 * @param band - 使う行の帯
 * @returns 長さ side の配列(センサーから見て左端の列から)
 */
export function scanLine(
  frame: RangingFrame,
  orientation: Orientation,
  band: RowBand,
): ScanPoint[] {
  const side = frame.side;
  const rows = bandRows(side, band);
  const distances = frame.fields.distance_mm;
  const out: ScanPoint[] = [];
  for (let sensorCol = 0; sensorCol < side; sensorCol++) {
    const col = side - 1 - sensorCol; // 正面から見た図の列
    let nearest: number | null = null;
    for (const row of rows) {
      const zone = zoneAt(row, col, side, orientation);
      const d = distances?.[zone * frame.targetsPerZone];
      if (d === undefined || d <= 0 || classifyZone(frame, zone) !== "ok") {
        continue;
      }
      if (nearest === null || d < nearest) {
        nearest = d;
      }
    }
    const angleDeg = zoneAnglesDeg(zoneAt(0, col, side, orientation), side, orientation).ax;
    const p = nearest === null ? null : pointAt({ ax: angleDeg, ay: 0 }, nearest, "perpendicular");
    out.push({ sensorCol, angleDeg, distanceMm: nearest, x: p?.x ?? null, z: p?.z ?? null });
  }
  return out;
}

/** 残像の 1 本 */
export interface HistoryEntry {
  readonly timeMs: number;
  readonly scan: readonly ScanPoint[];
}

/**
 * スキャン線の残像。直近 durationMs のスキャン線を持ち、経過時間に比例して薄くする。
 * 持つ数には上限がある(visible を呼ばずに add だけが続いても増え続けない。
 * 例: LiDAR 風ビューが表示されていない間も、受信のたびに add される)。
 */
export class ScanHistory {
  private entries: HistoryEntry[] = [];
  private readonly durationMs: number;
  private readonly maxEntries: number;

  /**
   * @param durationMs - 残像を残す時間 [ms](正)
   * @param maxEntries - 持つ数の上限(1 以上の整数。15 fps で 1.5 秒なら 23 本ほどなので、既定 64 で足りる)
   * @throws RangeError durationMs が正でない、maxEntries が 1 以上の整数でないとき
   */
  constructor(durationMs = 1500, maxEntries = 64) {
    if (!(durationMs > 0)) {
      throw new RangeError(`durationMs must be positive: ${durationMs}`);
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer: ${maxEntries}`);
    }
    this.durationMs = durationMs;
    this.maxEntries = maxEntries;
  }

  /** 持っている数(テストと確認用) */
  get size(): number {
    return this.entries.length;
  }

  /**
   * スキャン線を追加する(時刻は増える順に渡す)。追加した時刻から見て期限切れのものと、上限を超えた古いものを捨てる。
   */
  add(timeMs: number, scan: readonly ScanPoint[]): void {
    this.entries.push({ timeMs, scan });
    this.entries = this.entries.filter((e) => timeMs - e.timeMs < this.durationMs);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  /**
   * 表示する残像を、古い順に不透明度付きで返す。不透明度は 1 − 経過 / durationMs(新しいほど 1 に近い)。
   * 経過が durationMs 以上のものは捨てる。
   *
   * @param nowMs - 現在時刻 [ms]
   */
  visible(nowMs: number): { entry: HistoryEntry; alpha: number }[] {
    this.entries = this.entries.filter((e) => nowMs - e.timeMs < this.durationMs);
    return this.entries.map((entry) => ({
      entry,
      alpha: Math.min(1, 1 - (nowMs - entry.timeMs) / this.durationMs),
    }));
  }

  /** 残像を消す */
  clear(): void {
    this.entries = [];
  }
}

/** 動きの判定の設定 */
export interface MotionOptions {
  /** 背景との差のしきい値 [mm](既定 100。暫定) */
  readonly thresholdMm: number;
  /**
   * sigma を考慮する倍率。しきい値は max(thresholdMm, sigmaFactor × sigma)(既定 3)。
   * sigma が上限(SIGMA_MAX_MM = 50)を超えるゾーンはそもそも無効なので、倍率が 2 だと 2 × 50 = 100 で
   * しきい値を超えず、sigma が効かない。3 なら sigma 34 mm 以上でしきい値が上がる(50 mm で 150 mm)
   */
  readonly sigmaFactor: number;
  /** 背景の追従の速さ(1 フレームで差の何割だけ近づくか。0〜1。既定 0.05) */
  readonly followRate: number;
}

/** 動きの判定の既定値(暫定。記録を使って調整する) */
export const DEFAULT_MOTION_OPTIONS: MotionOptions = {
  thresholdMm: 100,
  sigmaFactor: 3,
  followRate: 0.05,
};

/**
 * 「空」(ターゲットなし)の背景を、追従の起点としてどの距離とみなすか [mm](VL53L8CX の最大測距距離 4 m)
 */
export const EMPTY_BACKGROUND_MM = 4000;

/** ゾーンの背景の状態 */
const BgState = {
  /** まだ何も見ていない */
  Unknown: 0,
  /** ターゲットなし(空) */
  Empty: 1,
  /** 距離の背景がある */
  Distance: 2,
} as const;

/**
 * 動いたゾーンの判定。ゾーンの背景(距離の遅い移動平均)と比べる。
 *
 * - 有効なゾーン(classifyZone が ok で距離が正): 背景がまだなければ、その距離を背景にする(動きなし)。
 *   背景が距離なら、差が max(thresholdMm, sigmaFactor × sigma) を超えたら「動いた」。
 *   背景が「空」なら、無条件に「動いた」とし、背景を EMPTY_BACKGROUND_MM から追従させ始める
 *   (何もなかった所に物が入った)。どの場合も、背景は毎フレーム followRate だけ距離に近づく(止まった物はやがて背景になる)
 * - ターゲットなしのゾーン(classifyZone が none): 背景を「空」にする(動きなし)。人が去った後に同じ所を通っても、再び検出できる
 * - ほかの無効なゾーン(ステータスが無効、sigma の上限超え、距離が 0 以下): 判定せず(動きなし)、背景も変えない
 * - 解像度かゾーンあたりのターゲット数が変わったら、背景を作り直す
 */
export class MotionDetector {
  private background: Float64Array | null = null;
  private state: Uint8Array | null = null;
  private side = 0;
  private targets = 0;
  private readonly options: MotionOptions;

  /**
   * @throws RangeError 設定が範囲外のとき
   */
  constructor(options: MotionOptions = DEFAULT_MOTION_OPTIONS) {
    if (!(options.thresholdMm >= 0) || !(options.sigmaFactor >= 0)) {
      throw new RangeError("thresholdMm and sigmaFactor must not be negative");
    }
    if (!(options.followRate > 0 && options.followRate <= 1)) {
      throw new RangeError(`followRate must be in (0, 1]: ${options.followRate}`);
    }
    this.options = options;
  }

  /**
   * フレームで背景を更新し、ゾーンごとの「動いた」を返す。
   *
   * @returns 長さ side² の配列(添字はゾーンの番号)
   */
  update(frame: RangingFrame): boolean[] {
    const zones = frame.side * frame.side;
    if (
      this.background === null ||
      this.state === null ||
      this.side !== frame.side ||
      this.targets !== frame.targetsPerZone
    ) {
      this.background = new Float64Array(zones).fill(Number.NaN);
      this.state = new Uint8Array(zones).fill(BgState.Unknown);
      this.side = frame.side;
      this.targets = frame.targetsPerZone;
    }
    const bg = this.background;
    const st = this.state;
    const moving = Array<boolean>(zones).fill(false);
    const distances = frame.fields.distance_mm;
    const sigmas = frame.fields.range_sigma_mm;
    for (let zone = 0; zone < zones; zone++) {
      const i = zone * frame.targetsPerZone;
      const cls = classifyZone(frame, zone);
      if (cls === "none") {
        st[zone] = BgState.Empty;
        bg[zone] = Number.NaN;
        continue;
      }
      const d = distances?.[i];
      if (d === undefined || d <= 0 || cls !== "ok") {
        continue;
      }
      const follow = (from: number): void => {
        bg[zone] = from + (d - from) * this.options.followRate;
      };
      switch (st[zone]) {
        case BgState.Empty:
          moving[zone] = true;
          st[zone] = BgState.Distance;
          follow(EMPTY_BACKGROUND_MM);
          break;
        case BgState.Distance: {
          const b = bg[zone] ?? d;
          const sigma = sigmas?.[i] ?? 0;
          const threshold = Math.max(this.options.thresholdMm, this.options.sigmaFactor * sigma);
          moving[zone] = Math.abs(d - b) > threshold;
          follow(b);
          break;
        }
        default:
          st[zone] = BgState.Distance;
          bg[zone] = d;
      }
    }
    return moving;
  }

  /** ゾーンの背景 [mm](まだない、または「空」なら NaN) */
  backgroundOf(zone: number): number {
    return this.background?.[zone] ?? Number.NaN;
  }

  /** ゾーンの背景が「空」(ターゲットなし)か */
  isEmpty(zone: number): boolean {
    return this.state?.[zone] === BgState.Empty;
  }

  /** 背景を消す */
  reset(): void {
    this.background = null;
    this.state = null;
    this.side = 0;
    this.targets = 0;
  }
}

/**
 * 走査型の模擬。センサーから見て左端の列を最も古いフレーム(side − 1 フレーム前)から、右端の列を最新のフレームから取った
 * 合成フレームを作る(1 回の走査に side フレームぶんの時間がかかる状況を模した、ローリングシャッターと同じ性質)。
 * 実際の走査型 LiDAR(1 列の測距時間、ミラーの速度、往復)を再現するものではない。
 */
export class ScanSimulator {
  private frames: RangingFrame[] = [];

  /**
   * 最後に作った合成フレームの、センサーから見た列ごとの元のフレームの seq(左端の列から。まだなければ空)。
   * マウスを乗せたゾーンが「どのフレームから取った値か」を表示するのに使う
   */
  get sourceSeqs(): readonly number[] {
    const side = this.frames[this.frames.length - 1]?.side ?? 0;
    return this.frames.length === side ? this.frames.map((f) => f.seq) : [];
  }

  /**
   * フレームを追加し、合成フレームを返す。
   *
   * @param frame - 新しい測距フレーム
   * @param orientation - 2D 画像が正面から見た見た目と一致する反転(センサーから見た列を決める)
   * @returns 合成フレーム。解像度・ターゲット数・フィールドが同じフレームが side 個たまるまでは null
   */
  push(frame: RangingFrame, orientation: Orientation): RangingFrame | null {
    const last = this.frames[this.frames.length - 1];
    if (
      last !== undefined &&
      (last.side !== frame.side ||
        last.targetsPerZone !== frame.targetsPerZone ||
        last.fieldMask !== frame.fieldMask)
    ) {
      this.frames = [];
    }
    this.frames.push(frame);
    if (this.frames.length > frame.side) {
      this.frames.shift();
    }
    if (this.frames.length < frame.side) {
      return null;
    }
    return composeScanned(this.frames, orientation);
  }

  /** たまったフレームを捨てる */
  reset(): void {
    this.frames = [];
  }
}

/**
 * 走査型の模擬で、ゾーンの値を何フレーム前のフレームから取っているか
 * (センサーから見て左端の列が side − 1 フレーム前、右端の列が 0 = 最新)。
 *
 * @throws RangeError zone や side が範囲外のとき
 */
export function scanLagFrames(zone: number, side: number, orientation: Orientation): number {
  return side - 1 - sensorColumn(zone, side, orientation);
}

/**
 * frames(古い順、長さ side)から、センサーから見た列 k を frames[k] から取った合成フレームを作る。
 * seq・タイムスタンプ・温度は最新のフレームのもの。
 */
function composeScanned(frames: readonly RangingFrame[], orientation: Orientation): RangingFrame {
  const latest = frames[frames.length - 1];
  if (latest === undefined) {
    throw new Error("no frames");
  }
  const side = latest.side;
  const T = latest.targetsPerZone;
  const zones = side * side;
  const fields: FrameFields = {};
  for (const spec of FIELD_SPECS) {
    const src = latest.fields[spec.name];
    if (src === undefined) continue;
    const per = spec.perTarget ? T : 1;
    const out = src.slice();
    for (let zone = 0; zone < zones; zone++) {
      const source = frames[sensorColumn(zone, side, orientation)]?.fields[spec.name];
      if (source === undefined) continue;
      for (let t = 0; t < per; t++) {
        out[zone * per + t] = source[zone * per + t] ?? 0;
      }
    }
    setField(fields, spec.name, out);
  }
  return { ...latest, fields };
}

/** FrameFields に名前で配列を入れる(フィールドごとの型を保つ) */
function setField(
  fields: FrameFields,
  name: keyof FrameFields,
  value: FrameFields[keyof FrameFields],
): void {
  switch (name) {
    case "distance_mm":
      if (value instanceof Int16Array) fields.distance_mm = value;
      break;
    case "target_status":
      if (value instanceof Uint8Array) fields.target_status = value;
      break;
    case "range_sigma_mm":
      if (value instanceof Uint16Array) fields.range_sigma_mm = value;
      break;
    case "nb_target_detected":
      if (value instanceof Uint8Array) fields.nb_target_detected = value;
      break;
    case "signal_per_spad":
      if (value instanceof Uint32Array) fields.signal_per_spad = value;
      break;
    case "nb_spads_enabled":
      if (value instanceof Uint32Array) fields.nb_spads_enabled = value;
      break;
  }
}
