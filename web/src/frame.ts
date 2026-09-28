/**
 * バイナリメッセージ(版 1)の解析と検証。DOM / Web API に依存しない。
 * 仕様: docs/frame-format.md。検査の順と拒否の理由は同文書の「受信側の手順」に合わせている。
 */

import { cobsDecode } from "./cobs.ts";
import { crc32 } from "./crc32.ts";

/** 対応する形式の版 */
export const FORMAT_VERSION = 1;

/** 共通ヘッダの長さ [バイト] */
export const COMMON_HEADER_LENGTH = 12;
/** 測距フレームのヘッダの長さ [バイト] */
export const FRAME_HEADER_LENGTH = 18;
/** ログのヘッダの長さ [バイト] */
export const LOG_HEADER_LENGTH = 16;
/** 状態のヘッダの長さ(firmware_version の前まで)[バイト] */
export const STATUS_HEADER_LENGTH = 27;
/** CRC-32 の長さ [バイト] */
export const CRC_LENGTH = 4;

/** 版 1 のゾーンあたりのターゲット数(T)の上限 */
export const MAX_TARGETS_PER_ZONE = 4;

/** 版 1 のペイロードの最大長(8x8、T = 4、全フィールド)[バイト] */
export const MAX_PAYLOAD_LENGTH = 2642;

/** メッセージ種別の値 */
export const MessageType = {
  Frame: 1,
  Log: 2,
  Status: 3,
} as const;

/**
 * 拒否の理由。docs/frame-format.md の「受信側の手順」の理由の語と同じ
 * (`ignore` は拒否ではないのでここには含めない)。
 */
export type RejectReason =
  "cobs" | "length" | "crc" | "magic" | "version" | "type" | "frame_header" | "log" | "status";

/** フィールドの名前(field_mask のビット順) */
export type FieldName =
  | "distance_mm"
  | "target_status"
  | "range_sigma_mm"
  | "nb_target_detected"
  | "signal_per_spad"
  | "nb_spads_enabled";

/** フィールドの定義 */
export interface FieldSpec {
  /** field_mask のビット番号 */
  readonly bit: number;
  /** 名前 */
  readonly name: FieldName;
  /** 要素のバイト数 */
  readonly elementSize: 1 | 2 | 4;
  /** true ならターゲットごと(Z × T 要素)、false ならゾーンごと(Z 要素) */
  readonly perTarget: boolean;
}

/** 版 1 のフィールドの定義(ビットの小さい順。ペイロード内の並び順と同じ) */
export const FIELD_SPECS: readonly FieldSpec[] = [
  { bit: 0, name: "distance_mm", elementSize: 2, perTarget: true },
  { bit: 1, name: "target_status", elementSize: 1, perTarget: true },
  { bit: 2, name: "range_sigma_mm", elementSize: 2, perTarget: true },
  { bit: 3, name: "nb_target_detected", elementSize: 1, perTarget: false },
  { bit: 4, name: "signal_per_spad", elementSize: 4, perTarget: true },
  { bit: 5, name: "nb_spads_enabled", elementSize: 4, perTarget: false },
];

/** 版 1 で定義されているフィールドのビット(0x003F)。これ以外のビットは予約 */
export const KNOWN_FIELD_MASK = 0x003f;

/** 測距フレームのフィールドの配列。field_mask に含むものだけがある */
export interface FrameFields {
  /** 距離 [mm](Z × T、添字 zone × T + t) */
  distance_mm?: Int16Array;
  /** 測距ステータス(Z × T)。5 と 9 が有効、255 はターゲットなし */
  target_status?: Uint8Array;
  /** 距離の標準偏差 [mm](Z × T) */
  range_sigma_mm?: Uint16Array;
  /** 検出したターゲット数(Z) */
  nb_target_detected?: Uint8Array;
  /** 信号の強さ [kcps/SPAD](Z × T) */
  signal_per_spad?: Uint32Array;
  /** 有効にした SPAD の数(Z) */
  nb_spads_enabled?: Uint32Array;
}

/** 測距フレーム(種別 1) */
export interface RangingFrame {
  readonly type: "frame";
  readonly seq: number;
  readonly timestampUs: number;
  /** 一辺のゾーン数(4 または 8) */
  readonly side: number;
  /** ゾーンあたりターゲット数 T(1〜4) */
  readonly targetsPerZone: number;
  readonly fieldMask: number;
  /** センサーの温度 [℃] */
  readonly temperatureC: number;
  readonly fields: FrameFields;
}

/** ログのレベル: 0 = 情報、1 = 警告、2 = エラー */
export type LogLevel = 0 | 1 | 2;

/** ログ(種別 2) */
export interface LogMessage {
  readonly type: "log";
  readonly seq: number;
  readonly timestampUs: number;
  readonly level: LogLevel;
  /** 文字列。印字可能な ASCII 以外のバイトは `?` に置き換えてある */
  readonly text: string;
}

/** 状態(種別 3) */
export interface StatusMessage {
  readonly type: "status";
  readonly seq: number;
  readonly timestampUs: number;
  readonly side: number;
  readonly targetsPerZone: number;
  readonly fieldMask: number;
  /** 測距の頻度の設定値 [Hz] */
  readonly rangingHz: number;
  /** flags の生の値(bit0 = flip_h、bit1 = flip_v) */
  readonly flags: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
  /** I2C の実際のクロック [Hz] */
  readonly i2cHz: number;
  /** センサーから 1 フレームで読むバイト数 */
  readonly sensorReadBytes: number;
  /** ファームウェアの版の文字列(印字可能な ASCII 以外は `?` に置き換えてある) */
  readonly firmwareVersion: string;
}

/** 解析したメッセージ */
export type Message = RangingFrame | LogMessage | StatusMessage;

/** 解析の結果。失敗は例外ではなくこの値で返す */
export type ParseResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly reason: RejectReason };

function reject(reason: RejectReason): ParseResult {
  return { ok: false, reason };
}

/**
 * 測距フレームのペイロードの長さを、ヘッダの値から計算する。
 *
 * @param side - 一辺のゾーン数
 * @param targetsPerZone - ゾーンあたりターゲット数
 * @param fieldMask - 含むフィールドのビットマスク(予約ビットは無視する)
 * @returns ペイロードの長さ [バイト]
 */
export function frameLength(side: number, targetsPerZone: number, fieldMask: number): number {
  const zones = side * side;
  let length = FRAME_HEADER_LENGTH;
  for (const spec of FIELD_SPECS) {
    if (fieldMask & (1 << spec.bit)) {
      length += zones * (spec.perTarget ? targetsPerZone : 1) * spec.elementSize;
    }
  }
  return length;
}

/** side / T / field_mask が版 1 の範囲内か(測距フレームと状態で共通) */
function isValidLayout(side: number, targetsPerZone: number, fieldMask: number): boolean {
  return (
    (side === 4 || side === 8) &&
    targetsPerZone >= 1 &&
    targetsPerZone <= MAX_TARGETS_PER_ZONE &&
    (fieldMask & ~KNOWN_FIELD_MASK) === 0
  );
}

/**
 * バイト列を ASCII の文字列にする。印字可能な ASCII(0x20〜0x7E)以外は `?` に置き換える
 * (表示するときに制御文字を持ち込まないため)。
 */
function asciiText(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "?";
  }
  return s;
}

function parseFrame(view: DataView, seq: number, timestampUs: number): ParseResult {
  if (view.byteLength < FRAME_HEADER_LENGTH) {
    return reject("length");
  }
  const side = view.getUint8(12);
  const targetsPerZone = view.getUint8(13);
  const fieldMask = view.getUint16(14, true);
  const temperatureC = view.getInt8(16);
  const reserved = view.getUint8(17);
  if (!isValidLayout(side, targetsPerZone, fieldMask) || reserved !== 0) {
    return reject("frame_header");
  }
  if (view.byteLength !== frameLength(side, targetsPerZone, fieldMask)) {
    return reject("length");
  }

  // 以降の読み出しは、長さが式と一致していることを確認済みなので範囲内に収まる
  const zones = side * side;
  const fields: FrameFields = {};
  let offset = FRAME_HEADER_LENGTH;
  for (const spec of FIELD_SPECS) {
    if (!(fieldMask & (1 << spec.bit))) {
      continue;
    }
    const count = zones * (spec.perTarget ? targetsPerZone : 1);
    switch (spec.name) {
      case "distance_mm": {
        const a = new Int16Array(count);
        for (let i = 0; i < count; i++) a[i] = view.getInt16(offset + i * 2, true);
        fields.distance_mm = a;
        break;
      }
      case "target_status": {
        const a = new Uint8Array(count);
        for (let i = 0; i < count; i++) a[i] = view.getUint8(offset + i);
        fields.target_status = a;
        break;
      }
      case "range_sigma_mm": {
        const a = new Uint16Array(count);
        for (let i = 0; i < count; i++) a[i] = view.getUint16(offset + i * 2, true);
        fields.range_sigma_mm = a;
        break;
      }
      case "nb_target_detected": {
        const a = new Uint8Array(count);
        for (let i = 0; i < count; i++) a[i] = view.getUint8(offset + i);
        fields.nb_target_detected = a;
        break;
      }
      case "signal_per_spad": {
        const a = new Uint32Array(count);
        for (let i = 0; i < count; i++) a[i] = view.getUint32(offset + i * 4, true);
        fields.signal_per_spad = a;
        break;
      }
      case "nb_spads_enabled": {
        const a = new Uint32Array(count);
        for (let i = 0; i < count; i++) a[i] = view.getUint32(offset + i * 4, true);
        fields.nb_spads_enabled = a;
        break;
      }
    }
    offset += count * spec.elementSize;
  }
  return {
    ok: true,
    message: {
      type: "frame",
      seq,
      timestampUs,
      side,
      targetsPerZone,
      fieldMask,
      temperatureC,
      fields,
    },
  };
}

function toLogLevel(n: number): LogLevel | null {
  return n === 0 || n === 1 || n === 2 ? n : null;
}

function parseLog(view: DataView, seq: number, timestampUs: number): ParseResult {
  if (view.byteLength < LOG_HEADER_LENGTH) {
    return reject("length");
  }
  const level = toLogLevel(view.getUint8(12));
  const reserved = view.getUint8(13);
  if (level === null || reserved !== 0) {
    return reject("log");
  }
  const length = view.getUint16(14, true);
  if (view.byteLength !== LOG_HEADER_LENGTH + length) {
    return reject("length");
  }
  const text = asciiText(new Uint8Array(view.buffer, view.byteOffset + LOG_HEADER_LENGTH, length));
  return {
    ok: true,
    message: { type: "log", seq, timestampUs, level, text },
  };
}

function parseStatus(view: DataView, seq: number, timestampUs: number): ParseResult {
  if (view.byteLength < STATUS_HEADER_LENGTH) {
    return reject("length");
  }
  const side = view.getUint8(12);
  const targetsPerZone = view.getUint8(13);
  const fieldMask = view.getUint16(14, true);
  const rangingHz = view.getUint8(16);
  const flags = view.getUint8(17);
  if (!isValidLayout(side, targetsPerZone, fieldMask) || (flags & 0xfc) !== 0) {
    return reject("status");
  }
  const i2cHz = view.getUint32(18, true);
  const sensorReadBytes = view.getUint32(22, true);
  const fwLen = view.getUint8(26);
  if (view.byteLength !== STATUS_HEADER_LENGTH + fwLen) {
    return reject("length");
  }
  const firmwareVersion = asciiText(
    new Uint8Array(view.buffer, view.byteOffset + STATUS_HEADER_LENGTH, fwLen),
  );
  return {
    ok: true,
    message: {
      type: "status",
      seq,
      timestampUs,
      side,
      targetsPerZone,
      fieldMask,
      rangingHz,
      flags,
      flipH: (flags & 0x01) !== 0,
      flipV: (flags & 0x02) !== 0,
      i2cHz,
      sensorReadBytes,
      firmwareVersion,
    },
  };
}

/**
 * ペイロード(CRC を除いたもの)を解析・検証する。
 * 検査の順は docs/frame-format.md の「受信側の手順」の 4 以降。
 *
 * @param payload - ペイロード
 * @returns 解析したメッセージ、または拒否の理由
 */
export function parsePayload(payload: Uint8Array): ParseResult {
  if (payload.length < COMMON_HEADER_LENGTH) {
    return reject("length");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint8(0) !== 0x56 || view.getUint8(1) !== 0x38) {
    return reject("magic");
  }
  if (view.getUint8(2) !== FORMAT_VERSION) {
    return reject("version");
  }
  const type = view.getUint8(3);
  const seq = view.getUint32(4, true);
  const timestampUs = view.getUint32(8, true);
  switch (type) {
    case MessageType.Frame:
      return parseFrame(view, seq, timestampUs);
    case MessageType.Log:
      return parseLog(view, seq, timestampUs);
    case MessageType.Status:
      return parseStatus(view, seq, timestampUs);
    default:
      return reject("type");
  }
}

/**
 * パケット(ペイロード + CRC-32)を検証して解析する。COBS を使わない経路(WebSocket / UDP)でも使う。
 *
 * @param packet - ペイロードの後ろにリトルエンディアンの CRC-32 が付いたバイト列
 * @returns 解析したメッセージ、または拒否の理由
 */
export function parsePacket(packet: Uint8Array): ParseResult {
  if (packet.length < CRC_LENGTH) {
    return reject("length");
  }
  const payloadLength = packet.length - CRC_LENGTH;
  const payload = packet.subarray(0, payloadLength);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getUint32(payloadLength, true) !== crc32(payload)) {
    return reject("crc");
  }
  return parsePayload(payload);
}

/**
 * USB シリアルの 1 パケット(COBS でエンコードされ、区切りの 0x00 を除いたもの)をデコードして解析する。
 * 長さ 0 のパケット(0x00 の連続)は呼び出し側で無視すること(ここに渡すと `length` で拒否する)。
 *
 * @param encoded - COBS でエンコードされたバイト列
 * @returns 解析したメッセージ、または拒否の理由
 */
export function decodeSerialPacket(encoded: Uint8Array): ParseResult {
  const packet = cobsDecode(encoded);
  if (packet === null) {
    return reject("cobs");
  }
  return parsePacket(packet);
}
