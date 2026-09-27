/**
 * アプリの起点。画面の要素と、受信・再生・描画をつなぐ。グローバルな可変状態はこのファイルにだけ置く。
 */

import "./style.css";
import type { LogLevel, Message, RangingFrame, StatusMessage } from "./frame.ts";
import { Receiver } from "./receiver.ts";
import {
  cellFromPoint,
  drawDistanceImage,
  drawSignalImage,
  drawSpadImage,
  setupCanvas,
} from "./render.ts";
import { ReplayPlayer, buildReplaySchedule, type ReplayTiming } from "./replay.ts";
import { Scene3D, type Display3D, type Scene3DOptions } from "./scene3d.ts";
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
};

const ctx = {
  distance: setupCanvas(ui.imgDistance),
  signal: setupCanvas(ui.imgSignal),
  spads: setupCanvas(ui.imgSpads),
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
};
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
    const cell = cellFromPoint(e.clientX - rect.left, e.clientY - rect.top, side);
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

let lastStatsMs = 0;
function tick(nowMs: number): void {
  if (state.imagesDirty) {
    state.imagesDirty = false;
    renderImages();
  }
  if (state.sceneDirty) {
    state.sceneDirty = false;
    scene3d?.update(state.latestFrame, scene3dOptions());
  }
  // データか 3D の設定かカメラが変わったときだけ描く
  scene3d?.renderIfNeeded();
  if (state.statusDirty) {
    state.statusDirty = false;
    renderStatus();
  }
  if (state.logsDirty) {
    state.logsDirty = false;
    renderLogs();
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
