/**
 * アプリの起点。画面の要素と、受信・再生・描画をつなぐ。グローバルな可変状態はこのファイルにだけ置く。
 */

import "./style.css";
import type { LogLevel, Message, RangingFrame, StatusMessage } from "./frame.ts";
import { Receiver } from "./receiver.ts";
import {
  GRID_PX,
  LEGEND_PX,
  cellFromPoint,
  drawDistanceImage,
  drawSignalImage,
  drawSpadImage,
  setupCanvas,
  sizeCanvas,
} from "./render.ts";
import {
  VIEW_IDS,
  isViewId,
  parseManifest,
  parseUrlOptions,
  type DemoEntry,
  type ViewId,
} from "./demos.ts";
import {
  LECTURE_A,
  LECTURE_B,
  LECTURE_C,
  LIDAR_VIEW_NOTE,
  PRESENTATION_HELP,
  SCAN_SIMULATION_LABEL,
  SWEEP_EFFECT_NOTE,
  type LecturePanel,
} from "./lecture/text.ts";
import { drawTopView, sweepAngleDeg } from "./lidarView.ts";
import {
  MotionDetector,
  ScanHistory,
  ScanSimulator,
  projectTop,
  scanLine,
  type RowBand,
  type ScanPoint,
} from "./scan2d.ts";
import { ReplayPlayer, buildReplaySchedule, type ReplayTiming } from "./replay.ts";
import {
  Scene3D,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  type Display3D,
  type Scene3DOptions,
} from "./scene3d.ts";
import type { DistanceModel } from "./geometry.ts";
import { SerialConnection, isWebSerialSupported, type SerialState } from "./serial.ts";
import { INTERVAL_GAP_FACTOR, STREAM_REJECT_REASONS } from "./stats.ts";
import {
  AutoRange,
  describeZone,
  firstTargets,
  minMax,
  zoneAt,
  type ColorBy,
  type Range,
} from "./view.ts";

/** id で要素を取り、型を実行時に確かめる(index.html と食い違ったら起動時に分かるようにする) */
function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) {
    throw new Error(`element #${id} is missing or not a ${type.name}`);
  }
  return e;
}

const ui = {
  connect: el("connect", HTMLButtonElement),
  disconnect: el("disconnect", HTMLButtonElement),
  connection: el("connection", HTMLSpanElement),
  replayFile: el("replay-file", HTMLInputElement),
  replayTiming: el("replay-timing", HTMLSelectElement),
  replaySpeed: el("replay-speed", HTMLSelectElement),
  replayLoop: el("replay-loop", HTMLInputElement),
  replayPlay: el("replay-play", HTMLButtonElement),
  replayPause: el("replay-pause", HTMLButtonElement),
  replayStop: el("replay-stop", HTMLButtonElement),
  replayProgress: el("replay-progress", HTMLSpanElement),
  flipH: el("flip-h", HTMLInputElement),
  flipV: el("flip-v", HTMLInputElement),
  showNumbers: el("show-numbers", HTMLInputElement),
  imgDistance: el("img-distance", HTMLCanvasElement),
  imgSignal: el("img-signal", HTMLCanvasElement),
  imgSpads: el("img-spads", HTMLCanvasElement),
  zoneInfo: el("zone-info", HTMLPreElement),
  stats: el("stats", HTMLDListElement),
  status: el("status", HTMLDListElement),
  logs: el("logs", HTMLOListElement),
  model3d: el("model3d", HTMLSelectElement),
  display3d: el("display3d", HTMLSelectElement),
  color3d: el("color3d", HTMLSelectElement),
  invalid3d: el("invalid3d", HTMLInputElement),
  reset3d: el("reset3d", HTMLButtonElement),
  view3d: el("view3d", HTMLCanvasElement),
  note3d: el("note3d", HTMLParagraphElement),
  demoSelect: el("demo-select", HTMLSelectElement),
  demoPlay: el("demo-play", HTMLButtonElement),
  demoStatus: el("demo-status", HTMLSpanElement),
  viewSelect: el("view-select", HTMLSelectElement),
  present: el("present", HTMLButtonElement),
  presentHelp: el("present-help", HTMLSpanElement),
  presentFooter: el("present-footer", HTMLParagraphElement),
  lidarBand: el("lidar-band", HTMLSelectElement),
  lidarRange: el("lidar-range", HTMLSelectElement),
  lidarTrail: el("lidar-trail", HTMLInputElement),
  lidarMotion: el("lidar-motion", HTMLInputElement),
  lidarSweep: el("lidar-sweep", HTMLInputElement),
  lidarCanvas: el("lidar-canvas", HTMLCanvasElement),
  lidarNote: el("lidar-note", HTMLParagraphElement),
  sweepNote: el("sweep-note", HTMLParagraphElement),
};

/** レクチャーのパネルの要素 */
interface LectureUi {
  readonly title: HTMLHeadingElement;
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  readonly canvasLeft: HTMLCanvasElement;
  readonly canvasRight: HTMLCanvasElement;
  readonly lines: HTMLUListElement;
}

function lectureUi(key: "A" | "B" | "C"): LectureUi {
  return {
    title: el(`lecture${key}-title`, HTMLHeadingElement),
    left: el(`lecture${key}-left`, HTMLElement),
    right: el(`lecture${key}-right`, HTMLElement),
    canvasLeft: el(`lecture${key}-canvas-left`, HTMLCanvasElement),
    canvasRight: el(`lecture${key}-canvas-right`, HTMLCanvasElement),
    lines: el(`lecture${key}-lines`, HTMLUListElement),
  };
}

const lectureEls = { A: lectureUi("A"), B: lectureUi("B"), C: lectureUi("C") };

/** 描画コンテキストと、大きさを決めた canvas の CSS px(layout() が全画面・リサイズで作り直す) */
const ctx = {
  distance: setupCanvas(ui.imgDistance),
  signal: setupCanvas(ui.imgSignal),
  spads: setupCanvas(ui.imgSpads),
  lidar: sizeCanvas(ui.lidarCanvas, 640, 400),
  lidarSize: { width: 640, height: 400 },
  lectureA: {
    left: setupCanvas(lectureEls.A.canvasLeft),
    right: setupCanvas(lectureEls.A.canvasRight),
  },
  lectureB: {
    left: setupCanvas(lectureEls.B.canvasLeft),
    right: setupCanvas(lectureEls.B.canvasRight),
  },
  lectureC: {
    left: sizeCanvas(lectureEls.C.canvasLeft, 400, 300),
    right: sizeCanvas(lectureEls.C.canvasRight, 400, 300),
  },
  lectureCSize: { width: 400, height: 300 },
};

/** ログの一覧に残す件数 */
const MAX_LOGS = 200;

interface LogEntry {
  readonly source: "device" | "browser";
  readonly level: LogLevel;
  readonly text: string;
  readonly seq: number | null;
  readonly timestampUs: number | null;
  readonly time: Date;
}

interface AppState {
  latestFrame: RangingFrame | null;
  latestStatus: StatusMessage | null;
  logs: LogEntry[];
  /** マウスが乗っている画面のセル(行・列)。ゾーンは描画のたびに現在の向きで求める */
  hoverCell: { readonly row: number; readonly col: number } | null;
  /**
   * このデータ源(接続・再生の開始)で最後に受け取った状態メッセージの flags。
   * 反転のチェックボックスは、データ源ごとの最初の状態メッセージと、flags が変わったとき
   * (ファームウェア側で h / v が押された)だけ上書きし、同じ flags の再送では画面の操作を残す
   */
  lastStatusFlags: number | null;
  signalRange: Range | null;
  spadRange: Range | null;
  imagesDirty: boolean;
  /** 3D の点群の属性を書き換える必要があるか(データ・向き・3D の設定が変わった) */
  sceneDirty: boolean;
  logsDirty: boolean;
  statusDirty: boolean;
  /** LiDAR 風ビューを描き直す必要があるか(残像・演出があるときは毎フレーム描く) */
  lidarDirty: boolean;
  /** レクチャーのパネルを描き直す必要があるか */
  lectureDirty: boolean;
  /** 最新のスキャン線 */
  scan: readonly ScanPoint[] | null;
  /** 最新のフレームでの、ゾーンごとの「動いた」 */
  moving: readonly boolean[] | null;
  /** 走査型の模擬の合成フレーム(フレームがたまるまでは null) */
  simulated: RangingFrame | null;
  /** 選んでいるビュー(全画面で大きく出すもの) */
  currentView: ViewId;
  /** プレゼンの表示(選んだビューだけを大きく出す)か */
  presenting: boolean;
  /** プレゼンの表示で Fullscreen API の全画面に入っているか */
  fullscreen: boolean;
}

// ---- 状態(このファイルだけが書き換える) ----
const state: AppState = {
  latestFrame: null,
  latestStatus: null,
  logs: [],
  hoverCell: null,
  lastStatusFlags: null,
  signalRange: null,
  spadRange: null,
  imagesDirty: true,
  sceneDirty: true,
  logsDirty: true,
  statusDirty: true,
  lidarDirty: true,
  lectureDirty: true,
  scan: null,
  moving: null,
  simulated: null,
  currentView: "lidar",
  presenting: false,
  fullscreen: false,
};
const scanHistory = new ScanHistory(1500);
const motion = new MotionDetector();
const scanSimulator = new ScanSimulator();
const signalAutoRange = new AutoRange();
const spadAutoRange = new AutoRange();

function orientation(): { flipH: boolean; flipV: boolean } {
  return { flipH: ui.flipH.checked, flipV: ui.flipV.checked };
}

function addLog(entry: Omit<LogEntry, "time">): void {
  state.logs.push({ ...entry, time: new Date() });
  if (state.logs.length > MAX_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_LOGS);
  }
  state.logsDirty = true;
}

function browserLog(level: LogLevel, text: string): void {
  addLog({ source: "browser", level, text, seq: null, timestampUs: null });
}

function onMessage(message: Message): void {
  switch (message.type) {
    case "frame": {
      state.latestFrame = message;
      const signal = message.fields.signal_per_spad;
      state.signalRange =
        signal === undefined
          ? null
          : signalAutoRange.update(
              minMax(firstTargets(signal, message.targetsPerZone), (v) => v > 0),
            );
      const spads = message.fields.nb_spads_enabled;
      state.spadRange = spads === undefined ? null : spadAutoRange.update(minMax(spads));
      state.imagesDirty = true;
      state.sceneDirty = true;
      onFrameForScan(message);
      break;
    }
    case "status":
      state.latestStatus = message;
      if (state.lastStatusFlags === null || state.lastStatusFlags !== message.flags) {
        // ファームウェアの表示の反転を描画の反転に反映する(ホバー中のゾーンも描画時に向きから求め直す)
        ui.flipH.checked = message.flipH;
        ui.flipV.checked = message.flipV;
      }
      state.lastStatusFlags = message.flags;
      state.statusDirty = true;
      state.imagesDirty = true;
      state.sceneDirty = true;
      break;
    case "log":
      addLog({
        source: "device",
        level: message.level,
        text: message.text,
        seq: message.seq,
        timestampUs: message.timestampUs,
      });
      break;
  }
}

const receiver = new Receiver(onMessage, () => performance.now());

/** 新しいデータ源(接続・再生)を始める前に、受信と表示の状態を消す */
function resetReception(): void {
  receiver.reset();
  state.latestFrame = null;
  state.latestStatus = null;
  state.lastStatusFlags = null;
  state.signalRange = null;
  state.spadRange = null;
  signalAutoRange.reset();
  spadAutoRange.reset();
  state.imagesDirty = true;
  state.sceneDirty = true;
  state.statusDirty = true;
  scanHistory.clear();
  motion.reset();
  scanSimulator.reset();
  state.scan = null;
  state.moving = null;
  state.simulated = null;
  state.lidarDirty = true;
  state.lectureDirty = true;
}

// ---- シリアル ----
/** 接続してから、メッセージが 1 つも来ないときに注意を出すまでの時間 [ms] */
const NO_MESSAGE_WARNING_MS = 3000;
/** 接続した時刻(未接続なら null) */
let connectedAtMs: number | null = null;
let noMessageWarned = false;

/**
 * 'b' を送ってもメッセージが来ない場合の注意(docs/frame-format.md の「モードの切り替え」)。
 * ファームウェアがテキスト表示のまま('b' が届いていない)か、センサーの初期化に失敗して止まっている。
 */
function checkNoMessage(nowMs: number): void {
  const s = receiver.stats.counts;
  if (
    connectedAtMs === null ||
    noMessageWarned ||
    s.frame + s.log + s.status > 0 ||
    nowMs - connectedAtMs < NO_MESSAGE_WARNING_MS
  ) {
    return;
  }
  noMessageWarned = true;
  const text =
    "接続から 3 秒たってもメッセージが来ない。ファームウェアがテキスト表示のまま('b' が届いていない。DTR・ポートを確認)か、" +
    "センサーの初期化に失敗して止まっている(赤 LED、テキストで FAILED を出し続け、キーを受け付けない)ことを疑う";
  ui.connection.textContent = `接続済み(注意: メッセージが来ない)`;
  browserLog(1, text);
}

const serial = new SerialConnection({
  onChunk: (chunk) => {
    receiver.push(chunk);
  },
  onStateChange: (s: SerialState, detail?: string) => {
    const labels: Record<SerialState, string> = {
      disconnected: "未接続",
      connecting: "接続中…",
      connected: "接続済み",
      disconnecting: "切断中…",
    };
    ui.connection.textContent = detail === undefined ? labels[s] : `${labels[s]}(${detail})`;
    ui.connect.disabled = s !== "disconnected" || !isWebSerialSupported();
    ui.disconnect.disabled = s !== "connected";
    connectedAtMs = s === "connected" ? performance.now() : null;
    noMessageWarned = false;
    if (detail !== undefined) {
      browserLog(1, `シリアル: ${labels[s]}(${detail})`);
    }
  },
  onWarning: (message) => {
    browserLog(1, `シリアル: ${message}`);
  },
});

if (!isWebSerialSupported()) {
  ui.connect.disabled = true;
  ui.connection.textContent =
    "Web Serial が使えない(Chrome / Edge で、https または localhost から開く)。記録ファイルの再生は使える";
}

ui.connect.addEventListener("click", () => {
  // requestPort はユーザー操作の中で呼ぶ必要があるので、この処理の中で await より前に connect を呼ぶ
  player.stop();
  resetReception();
  void serial.connect();
});

ui.disconnect.addEventListener("click", () => {
  void serial.disconnect();
});

window.addEventListener("beforeunload", () => {
  // ページを閉じるときは待てないので、送れる範囲で 't' を送って閉じる
  void serial.disconnect();
});

// ---- 記録ファイルの再生 ----
let replayData: Uint8Array | null = null;

const player = new ReplayPlayer({
  sink: (bytes) => {
    receiver.push(bytes);
  },
  // 再生の開始と繰り返しの継ぎ目で、受信処理・統計・表示を新しいデータ源として始め直す
  onRestart: resetReception,
  onEnd: () => {
    updateReplayButtons();
  },
});

function replayTiming(): ReplayTiming {
  return ui.replayTiming.value === "fixed"
    ? { mode: "fixed", fps: 15 }
    : { mode: "timestamp", maxGapMs: 1000 };
}

function updateReplayButtons(): void {
  const loaded = replayData !== null;
  ui.replayPlay.disabled = !loaded || player.state === "playing" || serial.state !== "disconnected";
  ui.replayPause.disabled = player.state !== "playing";
  ui.replayStop.disabled = player.state === "stopped";
}

ui.replayFile.addEventListener("change", () => {
  const file = ui.replayFile.files?.[0];
  if (file === undefined) {
    return;
  }
  player.stop();
  file
    .arrayBuffer()
    .then((buffer) => {
      replayData = new Uint8Array(buffer);
      player.load(buildReplaySchedule(replayData, replayTiming()));
      browserLog(0, `記録ファイル ${file.name}(${replayData.length} バイト)を読み込んだ`);
      updateReplayButtons();
    })
    .catch((e: unknown) => {
      replayData = null;
      browserLog(2, `記録ファイルを読めない: ${String(e)}`);
      updateReplayButtons();
    });
});

ui.replayTiming.addEventListener("change", () => {
  if (replayData !== null) {
    player.load(buildReplaySchedule(replayData, replayTiming()));
    updateReplayButtons();
  }
});

/**
 * 速度と繰り返しを画面から読み直す。ブラウザが再読み込み時にフォームの値を復元することがあるので、
 * change イベントだけに頼らず、起動時と再生の開始時にも読む
 */
function syncReplayOptions(): void {
  const speed = Number(ui.replaySpeed.value);
  player.speed = speed > 0 ? speed : 1;
  player.loop = ui.replayLoop.checked;
}
syncReplayOptions();

ui.replaySpeed.addEventListener("change", syncReplayOptions);
ui.replayLoop.addEventListener("change", syncReplayOptions);

ui.replayPlay.addEventListener("click", () => {
  syncReplayOptions();
  player.play();
  updateReplayButtons();
});

ui.replayPause.addEventListener("click", () => {
  player.pause();
  updateReplayButtons();
});

ui.replayStop.addEventListener("click", () => {
  player.stop();
  updateReplayButtons();
});

// ---- 表示の切り替えとマウス ----
for (const input of [ui.flipH, ui.flipV, ui.showNumbers]) {
  input.addEventListener("change", () => {
    state.imagesDirty = true;
    state.sceneDirty = true;
    // 向きが変わると列の対応が変わるので、残像と模擬のたまったフレームを捨てる
    scanHistory.clear();
    scanSimulator.reset();
    state.simulated = null;
    recomputeScan();
  });
}

// ---- 3D ----
/** 3D ビュー。WebGL が使えない環境では null(注記に理由を出し、2D の表示は続ける) */
/** 3D の注記の元の文(WebGL のコンテキストの状態を前に足すため) */
const note3dText = ui.note3d.textContent;
const scene3d: Scene3D | null = (() => {
  try {
    return new Scene3D(ui.view3d, (lost) => {
      ui.note3d.textContent = lost
        ? `WebGL のコンテキストが失われた(GPU のリセット等)。復帰を待っている。${note3dText}`
        : note3dText;
      browserLog(
        lost ? 1 : 0,
        lost ? "3D: WebGL のコンテキストが失われた" : "3D: WebGL のコンテキストが復帰した",
      );
    });
  } catch (e) {
    ui.note3d.textContent = `3D ビューを作れない(WebGL が使えない可能性): ${String(e)}`;
    return null;
  }
})();

function isDistanceModel(v: string): v is DistanceModel {
  return v === "perpendicular" || v === "radial";
}
function isDisplay3D(v: string): v is Display3D {
  return v === "points" || v === "patches";
}
function isColorBy(v: string): v is ColorBy {
  return v === "distance" || v === "signal" || v === "spads";
}

/** 3D の設定を画面から読む(select の値は index.html の option と対応。想定外なら既定値) */
function scene3dOptions(): Scene3DOptions {
  const model = ui.model3d.value;
  const display = ui.display3d.value;
  const colorBy = ui.color3d.value;
  return {
    model: isDistanceModel(model) ? model : "perpendicular",
    display: isDisplay3D(display) ? display : "points",
    colorBy: isColorBy(colorBy) ? colorBy : "distance",
    showInvalid: ui.invalid3d.checked,
    orientation: orientation(),
    ranges: { signal: state.signalRange, spads: state.spadRange },
  };
}

for (const input of [ui.model3d, ui.display3d, ui.color3d, ui.invalid3d]) {
  input.addEventListener("change", () => {
    state.sceneDirty = true;
  });
}
ui.reset3d.addEventListener("click", () => {
  scene3d?.resetView();
});

for (const canvas of [ui.imgDistance, ui.imgSignal, ui.imgSpads]) {
  canvas.addEventListener("mousemove", (e) => {
    const side = state.latestFrame?.side ?? 8;
    const rect = canvas.getBoundingClientRect();
    // 表示の倍率によらず、描画の座標(GRID_PX 基準)に直す
    const k = GRID_PX / Math.max(1, rect.width);
    const cell = cellFromPoint((e.clientX - rect.left) * k, (e.clientY - rect.top) * k, side);
    if (cell?.row !== state.hoverCell?.row || cell?.col !== state.hoverCell?.col) {
      state.hoverCell = cell;
      state.imagesDirty = true;
    }
  });
  canvas.addEventListener("mouseleave", () => {
    state.hoverCell = null;
    state.imagesDirty = true;
  });
}

// ---- 描画(requestAnimationFrame で最新の状態だけを描く) ----
function fillDl(dl: HTMLDListElement, rows: readonly (readonly [string, string])[]): void {
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

/** マウスが乗っているゾーン(セルと現在の向き・解像度から求める。範囲外なら null) */
function hoverZone(): number | null {
  const cell = state.hoverCell;
  const side = state.latestFrame?.side ?? 8;
  if (cell === null || cell.row >= side || cell.col >= side) {
    return null;
  }
  return zoneAt(cell.row, cell.col, side, orientation());
}

function renderImages(): void {
  const o = orientation();
  const frame = state.latestFrame;
  const zone = hoverZone();
  drawDistanceImage(ctx.distance, frame, o, zone, ui.showNumbers.checked);
  drawSignalImage(ctx.signal, frame, o, zone, state.signalRange);
  drawSpadImage(ctx.spads, frame, o, zone, state.spadRange);
  if (frame !== null && zone !== null) {
    ui.zoneInfo.textContent = describeZone(frame, zone).join("\n");
  } else if (zone === null) {
    ui.zoneInfo.textContent = "画像にマウスを乗せると、そのゾーンの値を表示する";
  }
}

function renderStats(nowMs: number): void {
  const s = receiver.stats;
  const frame = state.latestFrame;
  const rejects = STREAM_REJECT_REASONS.filter((r) => s.rejects[r] > 0)
    .map((r) => `${r} ${s.rejects[r]}`)
    .join(", ");
  fillDl(ui.stats, [
    ["受信 fps", s.frameRate.rate(nowMs).toFixed(1)],
    ["送信側 fps(タイムスタンプから)", s.sensorRate.rate().toFixed(1)],
    ["受信数", `フレーム ${s.counts.frame}、ログ ${s.counts.log}、状態 ${s.counts.status}`],
    ["seq の欠落", `${s.sequence.gaps} 回、${s.sequence.missing} 個`],
    ["seq の後退", `${s.sequence.backwards} 回`],
    [
      `間隔の異常(周期の ${INTERVAL_GAP_FACTOR} 倍超)`,
      `${s.intervals.gaps} 回(推定 ${s.intervals.skippedFrames} フレーム、最大間隔 ${(s.intervals.maxIntervalUs / 1000).toFixed(1)} ms)`,
    ],
    ["拒否", rejects === "" ? "0" : `${s.totalRejects}(${rejects})`],
    [
      "捨てたバイト",
      `最初の 0x00 の前 ${receiver.leadingBytes}、上限超え ${receiver.overflowBytes}`,
    ],
    ["長さ 0 のパケット(無視)", `${receiver.emptyPackets}`],
    ["温度", frame === null ? "—" : `${frame.temperatureC} ℃`],
    [
      "最新フレーム",
      frame === null
        ? "—"
        : `seq ${frame.seq}、${frame.side}x${frame.side}、T=${frame.targetsPerZone}、mask 0x${frame.fieldMask.toString(16).padStart(4, "0")}`,
    ],
  ]);
  const p = player.progress;
  ui.replayProgress.textContent =
    replayData === null ? "" : `${p.done} / ${p.total} 区間(${player.state})`;
}

function renderStatus(): void {
  const st = state.latestStatus;
  if (st === null) {
    fillDl(ui.status, [["", "まだ受け取っていない"]]);
    return;
  }
  fillDl(ui.status, [
    ["ファームウェア", st.firmwareVersion],
    ["解像度", `${st.side}x${st.side}、T=${st.targetsPerZone}`],
    ["field_mask", `0x${st.fieldMask.toString(16).padStart(4, "0")}`],
    ["測距の頻度", `${st.rangingHz} Hz`],
    ["反転(ファームウェア)", `h=${st.flipH ? 1 : 0} v=${st.flipV ? 1 : 0}`],
    ["I2C クロック", `${st.i2cHz} Hz`],
    ["1 フレームの読み出し", `${st.sensorReadBytes} バイト`],
    ["seq / timestamp", `${st.seq} / ${st.timestampUs} µs`],
  ]);
}

const LEVEL_LABELS: Readonly<Record<LogLevel, string>> = { 0: "INFO", 1: "WARN", 2: "ERROR" };

function renderLogs(): void {
  const items = state.logs.map((entry) => {
    const li = document.createElement("li");
    li.className = entry.source === "browser" ? "level-browser" : `level-${entry.level}`;
    const where =
      entry.source === "device"
        ? `seq ${entry.seq ?? "?"} t=${((entry.timestampUs ?? 0) / 1e6).toFixed(3)}s`
        : "browser";
    // textContent に入れるので、文字列に HTML が含まれても解釈されない
    li.textContent = `${entry.time.toLocaleTimeString()} [${LEVEL_LABELS[entry.level]}] (${where}) ${entry.text}`;
    return li;
  });
  const atBottom = ui.logs.scrollTop + ui.logs.clientHeight >= ui.logs.scrollHeight - 4;
  ui.logs.replaceChildren(...items);
  if (atBottom) {
    ui.logs.scrollTop = ui.logs.scrollHeight;
  }
}

// ---- LiDAR 風ビュー(Step 5) ----
function isRowBand(v: string): v is RowBand {
  return v === "all" || v === "center";
}

function lidarBand(): RowBand {
  const v = ui.lidarBand.value;
  return isRowBand(v) ? v : "center";
}

function lidarMaxRangeMm(): number {
  const v = Number(ui.lidarRange.value);
  return v > 0 ? v : 3000;
}

/** 測距フレームを受け取るたびに、スキャン線・残像・動き・走査型の模擬を更新する */
function onFrameForScan(frame: RangingFrame): void {
  const o = orientation();
  state.moving = motion.update(frame);
  // 解像度などが変わった直後は null(フレームがたまるまで「フレーム待ち」)
  state.simulated = scanSimulator.push(frame, o);
  const scan = scanLine(frame, o, lidarBand());
  state.scan = scan;
  scanHistory.add(performance.now(), scan);
  state.lidarDirty = true;
  state.lectureDirty = true;
}

/** 設定(行の帯・向き)が変わったとき、最新のフレームからスキャン線を作り直す */
function recomputeScan(): void {
  const frame = state.latestFrame;
  state.scan = frame === null ? null : scanLine(frame, orientation(), lidarBand());
  state.lidarDirty = true;
  state.lectureDirty = true;
}

ui.lidarNote.textContent = LIDAR_VIEW_NOTE;
ui.sweepNote.textContent = SWEEP_EFFECT_NOTE;
// 再読み込みでブラウザがチェックの状態を復元することがあるので、起動時にも合わせる
ui.sweepNote.hidden = !ui.lidarSweep.checked;
ui.lidarBand.addEventListener("change", () => {
  scanHistory.clear();
  recomputeScan();
});
for (const input of [ui.lidarRange, ui.lidarTrail, ui.lidarMotion, ui.lidarSweep]) {
  input.addEventListener("change", () => {
    ui.sweepNote.hidden = !ui.lidarSweep.checked;
    state.lidarDirty = true;
    state.lectureDirty = true;
  });
}

/** ビューが画面に出ているか(プレゼンの表示では選んだ 1 つだけ) */
function isVisible(view: ViewId): boolean {
  return !state.presenting || state.currentView === view;
}

function renderLidarIfNeeded(nowMs: number): void {
  if (!isVisible("lidar")) {
    return;
  }
  const history = ui.lidarTrail.checked ? scanHistory.visible(nowMs) : [];
  // 残像が薄れていく間と演出の間は毎フレーム描く。それ以外はデータか設定が変わったときだけ
  const animating = history.length > 0 || ui.lidarSweep.checked;
  if (!state.lidarDirty && !animating) {
    return;
  }
  state.lidarDirty = false;
  const frame = state.latestFrame;
  drawTopView(ctx.lidar, ctx.lidarSize.width, ctx.lidarSize.height, {
    points: frame === null ? [] : projectTop(frame, orientation()),
    scan: state.scan,
    history,
    moving: ui.lidarMotion.checked ? state.moving : null,
    maxRangeMm: lidarMaxRangeMm(),
    sweepAngleDeg: ui.lidarSweep.checked ? sweepAngleDeg(nowMs) : null,
    label: ui.lidarSweep.checked ? "演出あり" : null,
    pointColor: "distance",
  });
}

// ---- レクチャーの対比画面(Step 5) ----
function fillLecture(els: LectureUi, text: LecturePanel): void {
  els.title.textContent = text.title;
  els.left.textContent = text.left;
  els.right.textContent = text.right;
  els.lines.replaceChildren(
    ...text.lines.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
}
fillLecture(lectureEls.A, LECTURE_A);
fillLecture(lectureEls.B, LECTURE_B);
fillLecture(lectureEls.C, LECTURE_C);

function renderLectures(): void {
  const o = orientation();
  const frame = state.latestFrame;
  if (isVisible("lectureA")) {
    drawSignalImage(ctx.lectureA.left, frame, o, null, state.signalRange);
    drawSpadImage(ctx.lectureA.right, frame, o, null, state.spadRange);
  }
  if (isVisible("lectureB")) {
    drawDistanceImage(ctx.lectureB.left, frame, o, null, false);
    drawDistanceImage(ctx.lectureB.right, state.simulated, o, null, false);
    // 模擬であることを図の上に明記する(座標は GRID_PX 基準)
    const c = ctx.lectureB.right;
    c.save();
    c.fillStyle = "rgba(0, 0, 0, 0.6)";
    c.fillRect(0, 0, 64, 26);
    c.fillStyle = "#ff9f1c";
    c.font = "bold 16px system-ui, sans-serif";
    c.textAlign = "left";
    c.textBaseline = "top";
    c.fillText(SCAN_SIMULATION_LABEL, 8, 5);
    c.restore();
  }
  if (isVisible("lectureC")) {
    const { width, height } = ctx.lectureCSize;
    const pairs = [
      [ctx.lectureC.left, "perpendicular"],
      [ctx.lectureC.right, "radial"],
    ] as const;
    for (const [c, model] of pairs) {
      drawTopView(c, width, height, {
        points: frame === null ? [] : projectTop(frame, o, model),
        scan: null,
        history: [],
        moving: null,
        maxRangeMm: lidarMaxRangeMm(),
        sweepAngleDeg: null,
        label: null,
        pointColor: "distance",
      });
    }
  }
}

// ---- ビューとプレゼン(全画面)(Step 5) ----
const VIEW_LABELS: Readonly<Record<ViewId, string>> = {
  lidar: "LiDAR 風ビュー",
  "3d": "3D 点群",
  images: "2D 画像(距離・IR・SPAD 数)",
  lectureA: "レクチャー A: 受光側の調整",
  lectureB: "レクチャー B: フラッシュ型と走査型",
  lectureC: "レクチャー C: 垂直距離と半径",
};

ui.viewSelect.replaceChildren(
  ...VIEW_IDS.map((id, i) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${i + 1}: ${VIEW_LABELS[id]}`;
    return option;
  }),
);
ui.presentHelp.textContent = PRESENTATION_HELP;
ui.presentFooter.textContent = PRESENTATION_HELP;

function viewSection(view: ViewId): HTMLElement {
  return el(`view-${view}`, HTMLElement);
}

/** ビューを選ぶ。プレゼンの表示ではそれだけを出し、通常の表示ではそこまでスクロールする */
function setView(view: ViewId, scroll = true): void {
  state.currentView = view;
  ui.viewSelect.value = view;
  for (const id of VIEW_IDS) {
    viewSection(id).classList.toggle("active", id === view);
  }
  if (!state.presenting && scroll) {
    viewSection(view).scrollIntoView({ behavior: "smooth", block: "start" });
  }
  layout();
}

/**
 * プレゼンの表示に入る。fullscreen が true なら Fullscreen API も使う
 * (requestFullscreen はキー操作・クリックなどのユーザー操作の中でしか呼べない。URL パラメータで開いたときは false)。
 */
function enterPresentation(fullscreen: boolean): void {
  state.presenting = true;
  document.body.classList.add("presenting");
  setView(state.currentView);
  if (
    fullscreen &&
    !fullscreenPending &&
    document.fullscreenEnabled &&
    document.fullscreenElement === null
  ) {
    // 要求の完了を待つ間に F やボタンがもう一度押されても、二重に要求しない
    fullscreenPending = true;
    document.documentElement
      .requestFullscreen()
      .then(() => {
        state.fullscreen = true;
        layout();
      })
      .catch((e: unknown) => {
        browserLog(1, `全画面にできない(ページ内の表示で続ける): ${String(e)}`);
      })
      .finally(() => {
        fullscreenPending = false;
      });
  }
}

/** requestFullscreen の完了を待っているか */
let fullscreenPending = false;

function exitPresentation(): void {
  state.presenting = false;
  document.body.classList.remove("presenting");
  if (document.fullscreenElement !== null) {
    document.exitFullscreen().catch(() => undefined);
  }
  state.fullscreen = false;
  layout();
}

function togglePresentation(): void {
  if (fullscreenPending) {
    return;
  }
  if (state.presenting && (state.fullscreen || !document.fullscreenEnabled)) {
    exitPresentation();
  } else {
    // ページ内のプレゼンの表示(URL パラメータで開いた場合)から F を押したら、全画面にする
    enterPresentation(true);
  }
}

document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === null && state.fullscreen) {
    // Esc などでブラウザが全画面を終えた
    state.fullscreen = false;
    exitPresentation();
  } else {
    layout();
  }
});

ui.present.addEventListener("click", () => {
  enterPresentation(true);
});
ui.viewSelect.addEventListener("change", () => {
  const v = ui.viewSelect.value;
  if (isViewId(v)) setView(v);
  // select にフォーカスが残るとキー操作(F、1〜6)が効かないので外す
  ui.viewSelect.blur();
});

/** キー操作をテキスト入力などに渡すべきか(入力欄・選択・編集可能な要素にフォーカスがあるとき) */
function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "file"].includes(target.type);
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

window.addEventListener("keydown", (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTypingTarget(e.target)) {
    return;
  }
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    togglePresentation();
    return;
  }
  if (/^[1-9]$/.test(e.key)) {
    const view = VIEW_IDS[Number(e.key) - 1];
    if (view !== undefined) {
      e.preventDefault();
      setView(view);
    }
    return;
  }
  if (e.key === "Escape" && state.presenting && !state.fullscreen) {
    // 全画面でないプレゼンの表示(URL パラメータで開いた場合)から戻る。全画面の Esc はブラウザが処理する
    exitPresentation();
  }
});

/** 要素の上端から画面の下端までに残る高さ(下に置く要素の高さを引く。プレゼンの表示で canvas の大きさを決める) */
function spaceBelow(top: number, below: HTMLElement | null): number {
  const belowHeight = below === null ? 0 : below.getBoundingClientRect().height + 8;
  return window.innerHeight - top - belowHeight - 16;
}

/**
 * canvas の大きさを、通常の表示の既定値か、プレゼンの表示で画面いっぱいに合わせて決め直す。
 * 全画面の切り替え・ビューの切り替え・ウィンドウのリサイズで呼ぶ。canvas の大きさを変えると中身が消えるので、描き直しを要求する
 */
function layout(): void {
  const present = state.presenting;
  const width = window.innerWidth - 40;

  if (present && state.currentView === "lidar") {
    const top = ui.lidarCanvas.getBoundingClientRect().top;
    const h = Math.max(200, spaceBelow(top, ui.lidarNote) - (ui.sweepNote.hidden ? 0 : 30));
    ctx.lidarSize = { width, height: h };
  } else {
    ctx.lidarSize = { width: 640, height: 400 };
  }
  ctx.lidar = sizeCanvas(ui.lidarCanvas, ctx.lidarSize.width, ctx.lidarSize.height);

  if (scene3d !== null) {
    if (present && state.currentView === "3d") {
      const top = ui.view3d.getBoundingClientRect().top;
      scene3d.resize(width, Math.max(200, spaceBelow(top, ui.note3d)));
    } else {
      scene3d.resize(VIEW_WIDTH, VIEW_HEIGHT);
    }
  }

  // 2D 画像の倍率(3 枚を横に並べる)
  let imageScale = 1;
  if (present && state.currentView === "images") {
    const top = ui.imgDistance.getBoundingClientRect().top;
    imageScale = Math.min(
      (width - 48) / 3 / GRID_PX,
      spaceBelow(top, null) / (GRID_PX + LEGEND_PX),
    );
  }
  ctx.distance = setupCanvas(ui.imgDistance, imageScale);
  ctx.signal = setupCanvas(ui.imgSignal, imageScale);
  ctx.spads = setupCanvas(ui.imgSpads, imageScale);

  // レクチャー(2 枚を横に並べる)
  const lectureFit = (els: LectureUi): { w: number; h: number } | null => {
    if (!present) return null;
    const top = els.canvasLeft.getBoundingClientRect().top;
    return { w: (width - 32) / 2, h: Math.max(150, spaceBelow(top, els.lines)) };
  };
  const imageFit = (fit: { w: number; h: number } | null): number =>
    fit === null ? 0.8 : Math.min(fit.w / GRID_PX, fit.h / (GRID_PX + LEGEND_PX));
  const scaleA = imageFit(state.currentView === "lectureA" ? lectureFit(lectureEls.A) : null);
  ctx.lectureA = {
    left: setupCanvas(lectureEls.A.canvasLeft, scaleA),
    right: setupCanvas(lectureEls.A.canvasRight, scaleA),
  };
  const scaleB = imageFit(state.currentView === "lectureB" ? lectureFit(lectureEls.B) : null);
  ctx.lectureB = {
    left: setupCanvas(lectureEls.B.canvasLeft, scaleB),
    right: setupCanvas(lectureEls.B.canvasRight, scaleB),
  };
  const fitC = state.currentView === "lectureC" ? lectureFit(lectureEls.C) : null;
  ctx.lectureCSize =
    fitC === null ? { width: 400, height: 300 } : { width: fitC.w, height: fitC.h };
  ctx.lectureC = {
    left: sizeCanvas(lectureEls.C.canvasLeft, ctx.lectureCSize.width, ctx.lectureCSize.height),
    right: sizeCanvas(lectureEls.C.canvasRight, ctx.lectureCSize.width, ctx.lectureCSize.height),
  };

  state.imagesDirty = true;
  state.lidarDirty = true;
  state.lectureDirty = true;
}

/**
 * devicePixelRatio の変化(ウィンドウを別の倍率のモニタへ移した、ブラウザの拡大率を変えた)で描き直す。
 * resize イベントが来ない場合もあるので、今の値にだけ一致するメディアクエリの変化を見て、変わるたびに掛け直す
 */
function watchPixelRatio(): void {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    "change",
    () => {
      layout();
      watchPixelRatio();
    },
    { once: true },
  );
}
watchPixelRatio();

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  // リサイズ中は何度も来るので、止まってから 1 回だけ決め直す
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 100);
});

// ---- デモ用記録(Step 5) ----
/** 読み込んだデモの一覧(読み込み前・失敗時は空) */
let demos: readonly DemoEntry[] = [];

function demoUrl(file: string): string {
  // BASE_URL は vite の base(既定 "/")。dist/ をサブディレクトリに置いても動くように付ける
  return `${import.meta.env.BASE_URL}demos/${file}`;
}

async function loadDemoManifest(): Promise<void> {
  const response = await fetch(demoUrl("manifest.json"));
  if (!response.ok) {
    throw new Error(`manifest.json: HTTP ${response.status}`);
  }
  const result = parseManifest(await response.json());
  if (!result.ok) {
    throw new Error(`manifest.json の形が正しくない: ${result.errors.join("; ")}`);
  }
  demos = result.manifest.demos;
  ui.demoSelect.replaceChildren(
    ...demos.map((d) => {
      const option = document.createElement("option");
      option.value = d.id;
      option.textContent = `${d.title}(${d.seconds} 秒)`;
      option.title = d.description;
      return option;
    }),
  );
  ui.demoSelect.disabled = demos.length === 0;
  ui.demoPlay.disabled = demos.length === 0;
  ui.demoStatus.textContent = demos.length === 0 ? "デモがない" : "";
}

/**
 * デモの記録を取ってきて、ループ再生する。switchView が true なら、デモの推奨ビューに切り替える
 * (URL パラメータでビューも指定されていたときは、そちらを優先して切り替えない)
 */
async function playDemo(demo: DemoEntry, switchView: boolean): Promise<void> {
  if (serial.state !== "disconnected") {
    ui.demoStatus.textContent = "接続中は再生できない(切断してから)";
    return;
  }
  ui.demoStatus.textContent = "読み込み中…";
  const response = await fetch(demoUrl(demo.file));
  if (!response.ok) {
    throw new Error(`${demo.file}: HTTP ${response.status}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  player.stop();
  replayData = data;
  ui.replayTiming.value = "timestamp";
  ui.replayLoop.checked = true;
  syncReplayOptions();
  player.load(buildReplaySchedule(data, replayTiming()));
  player.play();
  updateReplayButtons();
  ui.demoStatus.textContent = `再生中: ${demo.title}`;
  browserLog(0, `デモ ${demo.id}(${demo.file}、${data.length} バイト)をループ再生`);
  if (switchView) {
    setView(demo.view);
  }
}

function playDemoById(id: string, switchView: boolean): void {
  const demo = demos.find((d) => d.id === id);
  if (demo === undefined) {
    ui.demoStatus.textContent = `デモ "${id}" は一覧にない`;
    return;
  }
  playDemo(demo, switchView).catch((e: unknown) => {
    ui.demoStatus.textContent = "読み込めない";
    browserLog(2, `デモを読み込めない: ${String(e)}`);
  });
}

ui.demoPlay.addEventListener("click", () => {
  playDemoById(ui.demoSelect.value, true);
});

// ---- 起動時: URL パラメータ(?view=...&demo=...) ----
const urlOptions = parseUrlOptions(window.location.search);
// 指定がなければ LiDAR 風ビューを選ぶだけ(スクロールはしない)
setView(urlOptions.view ?? "lidar", false);
if (urlOptions.view !== null) {
  // ビューを指定して開いたら、そのビューだけを大きく出す(全画面は F で。ユーザー操作なしには入れない)
  enterPresentation(false);
}
loadDemoManifest()
  .then(() => {
    if (urlOptions.demo !== null) {
      playDemoById(urlOptions.demo, urlOptions.view === null);
    }
  })
  .catch((e: unknown) => {
    ui.demoStatus.textContent = "デモの一覧を読めない";
    browserLog(2, `デモの一覧を読めない: ${String(e)}`);
  });

let lastStatsMs = 0;
function tick(nowMs: number): void {
  // プレゼンの表示で見えていないビューは描かない(dirty は残し、見えたときに描く)
  if (state.imagesDirty && isVisible("images")) {
    state.imagesDirty = false;
    renderImages();
  }
  if (isVisible("3d")) {
    if (state.sceneDirty) {
      state.sceneDirty = false;
      scene3d?.update(state.latestFrame, scene3dOptions());
    }
    // データか 3D の設定かカメラが変わったときだけ描く
    scene3d?.renderIfNeeded();
  }
  if (state.statusDirty) {
    state.statusDirty = false;
    renderStatus();
  }
  if (state.logsDirty) {
    state.logsDirty = false;
    renderLogs();
  }
  renderLidarIfNeeded(nowMs);
  if (state.lectureDirty) {
    state.lectureDirty = false;
    renderLectures();
  }
  if (nowMs - lastStatsMs >= 250) {
    lastStatsMs = nowMs;
    renderStats(nowMs);
    updateReplayButtons();
    checkNoMessage(performance.now());
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
