/**
 * Web Serial による接続・読み取りループ・切断・エラー処理。受信したチャンクを onChunk に渡すだけで、解析はしない。
 *
 * ブラウザの制約:
 * - Web Serial(navigator.serial)は Chromium 系(Chrome / Edge)のみ
 * - secure context(HTTPS または localhost)でしか使えない
 * - requestPort() はユーザー操作(クリック等)の処理の中からしか呼べない
 */

/** 接続の状態 */
export type SerialState = "disconnected" | "connecting" | "connected" | "disconnecting";

/** SerialConnection の設定 */
export interface SerialCallbacks {
  /** 受信したチャンク(任意の位置で分割されている)を渡す */
  readonly onChunk: (chunk: Uint8Array) => void;
  /** 状態が変わったときに呼ぶ。detail は理由(エラーの説明など) */
  /**
   * 状態が変わったときに呼ぶ。detail は理由、level はその重さ(USB の抜去によるデバイスの消失は "info"、
   * それ以外の理由は "warning")。1 回の切断で呼ぶのは 1 回(読み取りエラーと切断を別々に知らせない)
   */
  readonly onStateChange: (state: SerialState, detail?: string, level?: DetailLevel) => void;
  /** 接続を続けられるエラー(バッファあふれ等)を知らせる */
  readonly onWarning: (message: string) => void;
}

/** 状態の理由の重さ */
export type DetailLevel = "info" | "warning";

/** デバイスが外れたときの理由の文 */
export const DEVICE_LOST_DETAIL = "デバイスが外れた(USB の抜去など)";

/**
 * 読み取りの失敗がデバイスの消失(USB の抜去など)によるものか。
 * Web Serial は、デバイスが消えると読み取りを NetworkError(Chrome の文は "The device has been lost.")で失敗させる
 */
export function isDeviceLost(e: unknown): boolean {
  return e instanceof DOMException && e.name === "NetworkError";
}

/** 1 文字コマンド(docs/frame-format.md の「モードの切り替え」) */
const COMMAND_BINARY = "b";
const COMMAND_TEXT = "t";

/** コマンドを送るときの待ちの上限 [ms](送れなくても接続・切断の処理を止めない) */
const WRITE_TIMEOUT_MS = 500;

/** port.close() の待ちの上限 [ms](終わらなくても状態は disconnected に戻す) */
const CLOSE_TIMEOUT_MS = 1000;

/** Web Serial が使えるか(Chromium 系かつ secure context) */
export function isWebSerialSupported(): boolean {
  return "serial" in navigator && window.isSecureContext;
}

/**
 * Promise の結果を、期限付きで判別可能な値にする。期限を過ぎても元の処理は止めない
 * (後から失敗しても未処理の reject にならないように catch しておく)。
 */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<{ kind: "done" } | { kind: "error"; error: unknown } | { kind: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, ms);
  });
  const settled = promise.then(
    () => ({ kind: "done" }) as const,
    (error: unknown) => ({ kind: "error", error }) as const,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ポートがまだ読めるか(続けられるエラーの後は readable が新しいストリームに差し替わり、続けられないエラーの後は null)。
 * 読み取りの await の間に変わるので、TypeScript の絞り込みが古い値のままにならないよう関数越しに読む
 */
function hasReadable(port: SerialPort): boolean {
  return port.readable !== null;
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    return `${e.name}: ${e.message}`;
  }
  return String(e);
}

/** Web Serial で 1 つのポートにつなぐ */
export class SerialConnection {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private closing = false;
  /** 送信中のコマンドの終わり(次のコマンドはこれを待ってから送る) */
  private commandChain: Promise<void> = Promise.resolve();
  /** 終わっていない書き込みの数(タイムアウトした書き込みはここに残る) */
  private writesInFlight = 0;
  private currentState: SerialState = "disconnected";
  private readonly callbacks: SerialCallbacks;

  constructor(callbacks: SerialCallbacks) {
    this.callbacks = callbacks;
  }

  /** 現在の状態 */
  get state(): SerialState {
    return this.currentState;
  }

  private setState(state: SerialState, detail?: string, level: DetailLevel = "warning"): void {
    this.currentState = state;
    if (detail === undefined) {
      this.callbacks.onStateChange(state);
    } else {
      this.callbacks.onStateChange(state, detail, level);
    }
  }

  /**
   * ポートを選んで開き、DTR を立て、'b' を送ってバイナリの出力にし、読み取りを始める。
   * **ボタンのクリックなどのユーザー操作の処理から、最初の await より前に呼ぶこと**(requestPort の制約)。
   * 失敗しても例外は投げず、状態を disconnected に戻して detail で理由を知らせる。
   */
  async connect(): Promise<void> {
    if (this.currentState !== "disconnected") {
      return;
    }
    this.setState("connecting");
    let port: SerialPort;
    try {
      port = await navigator.serial.requestPort();
    } catch (e) {
      // 利用者がダイアログを閉じた場合も NotFoundError でここに来る
      this.setState("disconnected", `ポートを選ばなかった(${describeError(e)})`);
      return;
    }
    try {
      // USB CDC なのでボーレートは通信速度に関係しないが、open() には必須
      await port.open({ baudRate: 115200 });
    } catch (e) {
      this.setState("disconnected", `ポートを開けない(${describeError(e)})`);
      return;
    }
    try {
      // Pico SDK の USB CDC は DTR が立っていないと何も送らない。open() で立つかは未確認なので明示的に立てる
      await port.setSignals({ dataTerminalReady: true });
    } catch (e) {
      this.callbacks.onWarning(`DTR を立てられない(${describeError(e)})`);
    }
    this.port = port;
    this.closing = false;
    this.setState("connected");
    this.readLoop = this.runReadLoop(port);
    // 読み取りを始めてから 'b' を送る(ファームウェアは 0x00 → 状態 → 測距フレームの順に送る)
    if (!(await this.sendCommand(COMMAND_BINARY))) {
      this.callbacks.onWarning("'b' を送れなかった");
    }
  }

  /**
   * 1 文字のコマンドを送る。前のコマンドの送信中なら、それが終わる(またはタイムアウトする)のを待ってから送る
   * (接続直後の 'b' の送信中に切断しても、'b' の writer のロックが外れてから 't' を送るため)。
   *
   * @param command - 送る文字(ASCII)
   * @returns WRITE_TIMEOUT_MS 以内に送れたら true
   */
  sendCommand(command: string): Promise<boolean> {
    const result = this.commandChain.then(() => this.writeOnce(command));
    // 失敗しても次のコマンドは送れるように、チェーンには結果だけをつなぐ
    this.commandChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeOnce(command: string): Promise<boolean> {
    const writable = this.port?.writable;
    if (writable === null || writable === undefined || writable.locked) {
      return false;
    }
    const writer = writable.getWriter();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.writesInFlight++;
    const write = writer.write(new TextEncoder().encode(command)).then(
      () => true,
      () => false,
    );
    void write.finally(() => {
      this.writesInFlight--;
    });
    try {
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, WRITE_TIMEOUT_MS);
      });
      return await Promise.race([write, timeout]);
    } finally {
      clearTimeout(timer);
      // タイムアウトで書き込みが終わっていなくても、releaseLock はその書き込みを取り消さない
      // (Streams の仕様: 送信中の書き込みはストリーム側で続き、reject されるのは writer の ready / closed だけ)。
      // 未完了の書き込みはポートを閉じる前の abort で捨てる
      writer.releaseLock();
    }
  }

  /**
   * 送れるなら 't' を送ってテキスト表示に戻し、読み取りを止めてポートを閉じる。
   * 失敗しても例外は投げず、最後は disconnected にする。
   */
  async disconnect(): Promise<void> {
    if (this.currentState !== "connected") {
      return;
    }
    this.setState("disconnecting");
    this.closing = true;
    await this.sendCommand(COMMAND_TEXT);
    try {
      // 読み取り待ちを解除する。ループの finally で releaseLock する
      await this.reader?.cancel();
    } catch {
      // 既にエラーで閉じている場合など。後始末は続ける
    }
    await this.readLoop;
    // ループの終わりで closePort まで済んでいる
  }

  /**
   * 切断を要求されたか。disconnect() が await の間に書き換えるので、フィールドを直接読むと
   * TypeScript の絞り込みが古い値のままになる。メソッド越しに読む
   */
  private isClosing(): boolean {
    return this.closing;
  }

  /**
   * 読み取りループ。port.readable は、続けられるエラー(バッファあふれ・フレーミングエラー等)の後は
   * 新しいストリームに差し替わり、続けられないエラー(抜去等)の後は null になる(Web Serial の仕様)。
   */
  private async runReadLoop(port: SerialPort): Promise<void> {
    let detail: string | undefined;
    let level: DetailLevel = "warning";
    while (port.readable !== null && !this.isClosing()) {
      const reader = port.readable.getReader();
      this.reader = reader;
      let error: unknown = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          this.callbacks.onChunk(value);
        }
      } catch (e) {
        error = e;
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
      if (error === null || this.isClosing()) {
        continue;
      }
      if (isDeviceLost(error)) {
        // 抜去は利用者にとって普通の切断なので、警告ではなく情報として、切断の 1 行で知らせる
        detail = DEVICE_LOST_DETAIL;
        level = "info";
      } else {
        detail = `読み取りエラー(${describeError(error)})`;
        level = "warning";
        if (hasReadable(port)) {
          // 続けられるエラー(バッファあふれ等)。readable が新しいストリームに差し替わり、接続は続くので、ここで知らせる
          this.callbacks.onWarning(detail);
          detail = undefined;
        }
      }
    }
    await this.closePort(port, this.isClosing() ? undefined : (detail ?? "ポートが閉じた"), level);
  }

  private async closePort(
    port: SerialPort,
    detail: string | undefined,
    level: DetailLevel = "warning",
  ): Promise<void> {
    await this.commandChain;
    // タイムアウトして送れていない書き込みがあると close がそれを待つので、先に捨てる。
    // 送れた後に abort すると送信バッファの 't' を捨てかねないので、残っているときだけにする
    const writable = port.writable;
    if (this.writesInFlight > 0 && writable !== null && !writable.locked) {
      await withTimeout(writable.abort(), CLOSE_TIMEOUT_MS);
    }
    let closeDetail = detail;
    let closeLevel = level;
    const closed = await withTimeout(port.close(), CLOSE_TIMEOUT_MS);
    if (closed.kind === "timeout") {
      // 閉じ終わっていない可能性がある。同じポートに再接続すると open が InvalidStateError になりうる
      closeDetail = `ポートを閉じる処理が ${CLOSE_TIMEOUT_MS} ms で終わらなかった`;
      closeLevel = "warning";
    } else if (closed.kind === "error" && closeDetail === undefined) {
      // 抜去後などは close が失敗することがある(その場合は抜去の理由をそのまま使う)。状態は disconnected にする
      closeDetail = `ポートを閉じられない(${describeError(closed.error)})`;
      closeLevel = "warning";
    }
    this.port = null;
    this.readLoop = null;
    this.closing = false;
    this.setState("disconnected", closeDetail, closeLevel);
  }
}
