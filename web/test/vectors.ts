/**
 * docs/frame-vectors.json(C / Python と共通のテストベクタ)を読み込み、形を実行時に確かめる。
 */

import raw from "../../docs/frame-vectors.json?raw";
import type { Message } from "../src/frame.ts";

/**
 * 解析したメッセージを、テストベクタの `expect` と同じ形(キーは snake_case、配列は number[])にする。
 */
export function toExpectShape(m: Message): Record<string, unknown> {
  switch (m.type) {
    case "frame":
      return {
        type: "frame",
        seq: m.seq,
        timestamp_us: m.timestampUs,
        side: m.side,
        targets_per_zone: m.targetsPerZone,
        field_mask: m.fieldMask,
        temperature_c: m.temperatureC,
        fields: Object.fromEntries(
          Object.entries(m.fields).map(([k, v]: [string, ArrayLike<number>]) => [k, Array.from(v)]),
        ),
      };
    case "log":
      return {
        type: "log",
        seq: m.seq,
        timestamp_us: m.timestampUs,
        level: m.level,
        text: m.text,
      };
    case "status":
      return {
        type: "status",
        seq: m.seq,
        timestamp_us: m.timestampUs,
        side: m.side,
        targets_per_zone: m.targetsPerZone,
        field_mask: m.fieldMask,
        ranging_hz: m.rangingHz,
        flags: m.flags,
        i2c_hz: m.i2cHz,
        sensor_read_bytes: m.sensorReadBytes,
        firmware_version: m.firmwareVersion,
      };
  }
}

function fail(path: string, what: string): never {
  throw new Error(`frame-vectors.json: ${path} is not ${what}`);
}

export function asObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "an object");
  // JSON.parse の結果で、配列でも null でもない object はキーが文字列のオブジェクト。各値は使う側で検査する
  return v as Record<string, unknown>;
}

export function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "an array");
  return v;
}

export function asString(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "a string");
  return v;
}

export function asNumber(v: unknown, path: string): number {
  if (typeof v !== "number") fail(path, "a number");
  return v;
}

/** 16 進文字列(区切りなし、小文字)をバイト列にする */
export function hex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) {
    throw new Error(`invalid hex string: ${s.slice(0, 40)}`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface CobsVector {
  name: string;
  decoded: Uint8Array;
  encoded: Uint8Array;
}

export interface MessageVector {
  name: string;
  payload: Uint8Array;
  crc32: number;
  serial: Uint8Array;
  expect: Record<string, unknown>;
}

export interface InvalidVector {
  name: string;
  reject: string;
  serial: Uint8Array;
}

/** streams の期待値(JSON のキー名のまま) */
export interface StreamExpect {
  leading_bytes: number;
  trailing_bytes: number;
  empty_packets: number;
  accepted: number;
  accepted_by_type: { frame: number; log: number; status: number };
  rejected: Record<string, number>;
  accepted_seqs: number[];
  gaps: number;
  missing_messages: number;
  backward: number;
}

export interface StreamVector {
  name: string;
  /** 同期していない状態から流すバイト列 */
  serial: Uint8Array;
  expect: StreamExpect;
}

export interface Vectors {
  formatVersion: number;
  crcCheck: { input: string; crc32: number };
  cobs: CobsVector[];
  cobsDecodeOnly: CobsVector[];
  messages: MessageVector[];
  invalid: InvalidVector[];
  streams: StreamVector[];
  /** このテストが扱っていないトップレベルのセクション名 */
  unknownSections: string[];
}

const KNOWN_SECTIONS = [
  "description",
  "format_version",
  "crc32_check",
  "cobs",
  "cobs_decode_only",
  "messages",
  "invalid",
  "streams",
];

function numberRecord(v: unknown, path: string): Record<string, number> {
  const o = asObject(v, path);
  return Object.fromEntries(Object.entries(o).map(([k, n]) => [k, asNumber(n, `${path}.${k}`)]));
}

function streamExpect(v: unknown, path: string): StreamExpect {
  const o = asObject(v, path);
  const n = (key: string): number => asNumber(o[key], `${path}.${key}`);
  const byType = numberRecord(o.accepted_by_type, `${path}.accepted_by_type`);
  return {
    leading_bytes: n("leading_bytes"),
    trailing_bytes: n("trailing_bytes"),
    empty_packets: n("empty_packets"),
    accepted: n("accepted"),
    accepted_by_type: {
      frame: asNumber(byType.frame, `${path}.accepted_by_type.frame`),
      log: asNumber(byType.log, `${path}.accepted_by_type.log`),
      status: asNumber(byType.status, `${path}.accepted_by_type.status`),
    },
    rejected: numberRecord(o.rejected, `${path}.rejected`),
    accepted_seqs: asArray(o.accepted_seqs, `${path}.accepted_seqs`).map((s, i) =>
      asNumber(s, `${path}.accepted_seqs[${i}]`),
    ),
    gaps: n("gaps"),
    missing_messages: n("missing_messages"),
    backward: n("backward"),
  };
}

function cobsList(v: unknown, path: string): CobsVector[] {
  return asArray(v, path).map((item, i) => {
    const o = asObject(item, `${path}[${i}]`);
    return {
      name: asString(o.name, `${path}[${i}].name`),
      decoded: hex(asString(o.decoded_hex, `${path}[${i}].decoded_hex`)),
      encoded: hex(asString(o.encoded_hex, `${path}[${i}].encoded_hex`)),
    };
  });
}

function load(): Vectors {
  const root = asObject(JSON.parse(raw), "root");
  const check = asObject(root.crc32_check, "crc32_check");
  return {
    formatVersion: asNumber(root.format_version, "format_version"),
    crcCheck: {
      input: asString(check.input_ascii, "crc32_check.input_ascii"),
      crc32: parseInt(asString(check.crc32, "crc32_check.crc32"), 16),
    },
    cobs: cobsList(root.cobs, "cobs"),
    cobsDecodeOnly: cobsList(root.cobs_decode_only, "cobs_decode_only"),
    messages: asArray(root.messages, "messages").map((item, i) => {
      const p = `messages[${i}]`;
      const o = asObject(item, p);
      return {
        name: asString(o.name, `${p}.name`),
        payload: hex(asString(o.payload_hex, `${p}.payload_hex`)),
        crc32: parseInt(asString(o.crc32, `${p}.crc32`), 16),
        serial: hex(asString(o.serial_hex, `${p}.serial_hex`)),
        expect: asObject(o.expect, `${p}.expect`),
      };
    }),
    invalid: asArray(root.invalid, "invalid").map((item, i) => {
      const p = `invalid[${i}]`;
      const o = asObject(item, p);
      return {
        name: asString(o.name, `${p}.name`),
        reject: asString(o.reject, `${p}.reject`),
        serial: hex(asString(o.serial_hex, `${p}.serial_hex`)),
      };
    }),
    streams: asArray(root.streams, "streams").map((item, i) => {
      const p = `streams[${i}]`;
      const o = asObject(item, p);
      return {
        name: asString(o.name, `${p}.name`),
        serial: hex(asString(o.serial_hex, `${p}.serial_hex`)),
        expect: streamExpect(o.expect, `${p}.expect`),
      };
    }),
    unknownSections: Object.keys(root).filter((k) => !KNOWN_SECTIONS.includes(k)),
  };
}

/** 読み込んだテストベクタ */
export const vectors: Vectors = load();

/** バイト列を連結する */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 再現可能な擬似乱数(xorshift32) */
export function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}
