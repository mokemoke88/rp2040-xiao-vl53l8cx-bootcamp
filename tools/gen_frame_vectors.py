# SPDX-License-Identifier: MIT
"""docs/frame-format.md のテストベクタを作る(参照用のエンコーダ)。

C の実装(src/frame_proto.c)とは別に、仕様書どおりのエンコードを Python で書き、次の 2 つを出力する。

- docs/frame-vectors.json: ブラウザ側(TypeScript)と tools/verification/decode_capture.py が読むテストベクタ
- tests/frame_vectors.h: C のホストテスト(tests/test_frame_proto.c)が読む同じ内容の C の配列

C のテストは、同じ入力から C の実装で組み立てたバイト列がここの期待値と一致することを検査する。
つまり C と Python の 2 つの独立した実装が一致することを確かめている。

使い方(リポジトリ直下で):
    python tools/gen_frame_vectors.py          # 2 つのファイルを書き直す
    python tools/gen_frame_vectors.py --check  # 書き直した内容が今のファイルと同じか確かめる(make test で使う)
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "docs" / "frame-vectors.json"
HEADER_PATH = ROOT / "tests" / "frame_vectors.h"

MAGIC = b"V8"
VERSION = 1
TYPE_FRAME = 1
TYPE_LOG = 2
TYPE_STATUS = 3

# フィールド: (ビット, 名前, struct の書式, ターゲットごとか)
FIELDS = [
    (0, "distance_mm", "<h", True),
    (1, "target_status", "<B", True),
    (2, "range_sigma_mm", "<H", True),
    (3, "nb_target_detected", "<B", False),
    (4, "signal_per_spad", "<I", True),
    (5, "nb_spads_enabled", "<I", False),
]
LOG_TEXT_MAX = 200
VERSION_TEXT_MAX = 64


# ---------------------------------------------------------------- 参照エンコーダ


def crc32(data: bytes) -> int:
    """CRC-32(IEEE、反転あり、初期値 0xFFFFFFFF、最終 XOR 0xFFFFFFFF)をビットごとに計算する。"""
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xEDB88320 if crc & 1 else crc >> 1
    return crc ^ 0xFFFFFFFF


def cobs_encode(data: bytes) -> bytes:
    """COBS でエンコードする(254 バイトの非ゼロで終わる場合に 0x01 を足さない形)。区切りの 0x00 は付けない。"""
    out = bytearray()
    block = bytearray()
    for i, b in enumerate(data):
        if b == 0:
            out.append(len(block) + 1)
            out += block
            block.clear()
            continue
        block.append(b)
        if len(block) == 254:
            out.append(0xFF)
            out += block
            block.clear()
            if i + 1 == len(data):
                return bytes(out)
    out.append(len(block) + 1)
    out += block
    return bytes(out)


def common_header(msg_type: int, seq: int, ts: int) -> bytes:
    """全種別に共通のヘッダ(12 バイト)。"""
    return MAGIC + struct.pack("<BBII", VERSION, msg_type, seq, ts)


def printable(text: str, limit: int) -> bytes:
    """limit バイトで切り詰め、0x20〜0x7E 以外を '?' にする。"""
    raw = text.encode("latin-1")[:limit]
    return bytes(c if 0x20 <= c <= 0x7E else 0x3F for c in raw)


def build_frame(v: dict[str, Any]) -> bytes:
    """測距フレームのペイロード。"""
    side, targets, mask = v["side"], v["targets_per_zone"], v["field_mask"]
    zones = side * side
    body = common_header(TYPE_FRAME, v["seq"], v["timestamp_us"])
    body += struct.pack("<BBHbB", side, targets, mask, v["temperature_c"], 0)
    for bit, name, fmt, per_target in FIELDS:
        if not mask & (1 << bit):
            continue
        values = v["fields"][name]
        assert len(values) == (zones * targets if per_target else zones), name
        for x in values:
            body += struct.pack(fmt, x)
    return body


def build_log(v: dict[str, Any]) -> bytes:
    """ログのペイロード。"""
    text = printable(v["input_text"], LOG_TEXT_MAX)
    return common_header(TYPE_LOG, v["seq"], v["timestamp_us"]) + struct.pack("<BBH", v["level"], 0, len(text)) + text


def build_status(v: dict[str, Any]) -> bytes:
    """状態のペイロード。"""
    fw = printable(v["input_firmware_version"], VERSION_TEXT_MAX)
    return (
        common_header(TYPE_STATUS, v["seq"], v["timestamp_us"])
        + struct.pack(
            "<BBHBBIIB",
            v["side"],
            v["targets_per_zone"],
            v["field_mask"],
            v["ranging_hz"],
            v["flags"],
            v["i2c_hz"],
            v["sensor_read_bytes"],
            len(fw),
        )
        + fw
    )


def serial(payload: bytes, crc: int | None = None) -> bytes:
    """USB シリアルのリンク層: ペイロード + CRC(リトルエンディアン)を COBS にし、0x00 を付ける。"""
    c = crc32(payload) if crc is None else crc
    return cobs_encode(payload + struct.pack("<I", c)) + b"\x00"


# ---------------------------------------------------------------- ベクタの入力


def frame_4x4_all() -> dict[str, Any]:
    """4x4、全フィールド。値の境界(負の距離、0、65535、uint32 の最大など)を含む。"""
    return {
        "seq": 1,
        "timestamp_us": 123456,
        "side": 4,
        "targets_per_zone": 1,
        "field_mask": 0x3F,
        "temperature_c": -3,
        "fields": {
            "distance_mm": [0, 1, -5, 255, 256, 1000, 2000, 32767, -32768, 300, 400, 500, 600, 700, 800, 4000],
            "target_status": [5, 9, 6, 13, 255, 5, 5, 9, 0, 5, 5, 5, 5, 5, 5, 5],
            "range_sigma_mm": [0, 1, 2, 3, 65535, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
            "nb_target_detected": [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            "signal_per_spad": [0, 1, 255, 256, 65535, 65536, 0x01000000, 0xFFFFFFFF, 1234, 5678, 9012, 3456, 7890, 1, 2, 3],
            "nb_spads_enabled": [0, 1, 256, 0xFFFFFFFF, 3000, 4096, 12288, 65536, 100, 200, 300, 400, 500, 600, 700, 800],
        },
    }


def frame_8x8_all() -> dict[str, Any]:
    """8x8、全フィールド(ファームウェアが送る形)。シーケンス番号・タイムスタンプは折り返し直前の値。"""
    zones = 64
    status = [9 if i % 13 == 0 else (255 if i % 17 == 3 else 5) for i in range(zones)]
    return {
        "seq": 0xFFFFFFFE,
        "timestamp_us": 0xFFFFFFF0,
        "side": 8,
        "targets_per_zone": 1,
        "field_mask": 0x3F,
        "temperature_c": 45,
        "fields": {
            "distance_mm": [150 + i * 29 for i in range(zones)],
            "target_status": status,
            "range_sigma_mm": [5 + i % 23 for i in range(zones)],
            "nb_target_detected": [0 if s == 255 else 1 for s in status],
            "signal_per_spad": [0 if i == 10 else (i * i * 131 + 17 * i) % 100000 for i in range(zones)],
            "nb_spads_enabled": [0 if s == 255 else 2000 + (i * 97) % 9000 for i, s in enumerate(status)],
        },
    }


def frame_4x4_distance_status() -> dict[str, Any]:
    """4x4、距離とステータスだけ(マスク 0x0003)。"""
    base = frame_4x4_all()
    return {
        "seq": 7,
        "timestamp_us": 5000000,
        "side": 4,
        "targets_per_zone": 1,
        "field_mask": 0x03,
        "temperature_c": 25,
        "fields": {k: base["fields"][k] for k in ("distance_mm", "target_status")},
    }


def frame_4x4_two_targets() -> dict[str, Any]:
    """4x4、ゾーンあたり 2 ターゲット、全フィールド(ターゲットごとと、ゾーンごとの配列の長さの違いを示す)。"""
    zones, t = 16, 2
    return {
        "seq": 8,
        "timestamp_us": 42,
        "side": 4,
        "targets_per_zone": t,
        "field_mask": 0x3F,
        "temperature_c": 0,
        "fields": {
            "distance_mm": [100 * z + 10 * k for z in range(zones) for k in range(t)],
            "target_status": [5 if k == 0 else 9 for z in range(zones) for k in range(t)],
            "range_sigma_mm": [z + k for z in range(zones) for k in range(t)],
            "nb_target_detected": [2 if z % 3 else 1 for z in range(zones)],
            "signal_per_spad": [1000 * z + k for z in range(zones) for k in range(t)],
            "nb_spads_enabled": [5000 + z for z in range(zones)],
        },
    }


def frame_8x8_4targets_max() -> dict[str, Any]:
    """8x8、ゾーンあたり 4 ターゲット、全フィールド(版 1 の最大長 2642 バイト)。"""
    zones, t = 64, 4
    return {
        "seq": 11,
        "timestamp_us": 99,
        "side": 8,
        "targets_per_zone": t,
        "field_mask": 0x3F,
        "temperature_c": -128,
        "fields": {
            "distance_mm": [(z * 50 + k * 7) - 100 for z in range(zones) for k in range(t)],
            "target_status": [(5, 9, 255, 6)[(z + k) % 4] for z in range(zones) for k in range(t)],
            "range_sigma_mm": [(z * 13 + k) % 70 for z in range(zones) for k in range(t)],
            "nb_target_detected": [z % 5 for z in range(zones)],
            "signal_per_spad": [(z * 4096 + k * 256 + 1) for z in range(zones) for k in range(t)],
            "nb_spads_enabled": [3072 + (z % 5) * 256 for z in range(zones)],
        },
    }


def message_inputs() -> list[dict[str, Any]]:
    """正常なメッセージのベクタ(入力と期待値)。"""
    return [
        {"name": "frame_4x4_all_fields", "type": "frame", **frame_4x4_all()},
        {"name": "frame_8x8_all_fields", "type": "frame", **frame_8x8_all()},
        {"name": "frame_4x4_distance_status", "type": "frame", **frame_4x4_distance_status()},
        {"name": "frame_4x4_two_targets", "type": "frame", **frame_4x4_two_targets()},
        {"name": "frame_8x8_4targets_max", "type": "frame", **frame_8x8_4targets_max()},
        {"name": "log_info", "type": "log", "seq": 2, "timestamp_us": 1000, "level": 0, "input_text": "sensor alive"},
        {
            "name": "log_error_truncated",
            "type": "log",
            "seq": 9,
            "timestamp_us": 77,
            "level": 2,
            "input_text": "".join(chr(ord("A") + i % 26) for i in range(210)),
        },
        {
            "name": "status",
            "type": "status",
            "seq": 3,
            "timestamp_us": 2000,
            "side": 8,
            "targets_per_zone": 1,
            "field_mask": 0x3F,
            "ranging_hz": 15,
            "flags": 1,
            "i2c_hz": 399361,
            "sensor_read_bytes": 972,
            "input_firmware_version": "xiao-vl53l8cx-bootcamp step3 (ULD VL53L8CX_2.0.0)",
        },
    ]


def cobs_vectors() -> list[tuple[str, bytes]]:
    """COBS の境界のベクタ(デコード後のバイト列)。"""
    run254 = bytes(range(1, 255))
    return [
        ("empty", b""),
        ("single_zero", b"\x00"),
        ("two_zeros", b"\x00\x00"),
        ("zero_in_middle", b"\x11\x22\x00\x33"),
        ("no_zero", b"\x11\x22\x33\x44"),
        ("trailing_zeros", b"\x11\x00\x00\x00"),
        ("run_253", bytes(range(1, 254))),
        ("run_254", run254),
        ("zero_then_run_254", b"\x00" + run254),
        ("run_255", bytes(range(1, 256))),
        ("run_254_then_zero", run254 + b"\x00"),
        ("run_508", run254 + run254),
        ("run_509", run254 + run254 + b"\x01"),
    ]


def payload_of(inp: dict[str, Any]) -> bytes:
    """種別に応じてペイロードを組み立てる。"""
    return {"frame": build_frame, "log": build_log, "status": build_status}[inp["type"]](inp)


def invalid_vectors() -> list[dict[str, Any]]:
    """受信側が拒否(または無視)すべきバイト列。CRC は、狙った検査だけが失敗するように付け直してある。"""
    good = build_frame(frame_4x4_all())

    def patched(offset: int, value: int) -> bytes:
        b = bytearray(good)
        b[offset] = value
        return bytes(b)

    log = build_log(input_by_name("log_info"))
    status = build_status(input_by_name("status"))

    def patched_bytes(base: bytes, offset: int, value: int) -> bytes:
        b = bytearray(base)
        b[offset] = value
        return bytes(b)

    items: list[tuple[str, str, bytes]] = [
        ("empty_packet", "ignore", b"\x00"),
        ("cobs_code_past_end", "cobs", b"\x05\x11\x22\x00"),
        ("crc_mismatch", "crc", serial(good, crc32(good) ^ 0x00000001)),
        ("decoded_short", "length", cobs_encode(b"\x01\x02\x03") + b"\x00"),
        ("too_short", "length", serial(good[:3])),
        ("bad_magic", "magic", serial(patched(1, ord("9")))),
        ("bad_version", "version", serial(patched(2, 2))),
        ("unknown_type", "type", serial(patched(3, 9))),
        ("frame_bad_side", "frame_header", serial(patched(12, 5))),
        ("frame_bad_targets", "frame_header", serial(patched(13, 0))),
        ("frame_header_short", "length", serial(good[:17])),
        ("frame_reserved_field_bit", "frame_header", serial(patched(14, 0x7F))),
        ("frame_reserved_field_bit_high", "frame_header", serial(patched(15, 0x80))),
        ("frame_reserved_nonzero", "frame_header", serial(patched(17, 1))),
        ("frame_length_short", "length", serial(good[:-1])),
        ("frame_length_long", "length", serial(good + b"\x00")),
        ("log_header_short", "length", serial(log[:15])),
        ("log_bad_level", "log", serial(patched_bytes(log, 12, 3))),
        ("log_reserved_nonzero", "log", serial(patched_bytes(log, 13, 1))),
        ("log_length_mismatch", "length", serial(log[:-1])),
        ("status_header_short", "length", serial(status[:26])),
        ("status_bad_side", "status", serial(patched_bytes(status, 12, 5))),
        ("status_bad_targets", "status", serial(patched_bytes(status, 13, 0))),
        ("status_reserved_field_bit", "status", serial(patched_bytes(status, 14, 0x7F))),
        ("status_bad_flags", "status", serial(patched_bytes(status, 17, 0x04))),
        ("status_length_mismatch", "length", serial(status + b"X")),
    ]
    return [{"name": n, "reject": r, "serial_hex": b.hex()} for n, r, b in items]


def input_by_name(name: str) -> dict[str, Any]:
    """message_inputs() から名前で 1 つ取り出す。"""
    return next(i for i in message_inputs() if i["name"] == name)


def small_frame(seq: int) -> bytes:
    """ストリーム用の小さな測距フレーム(4x4、距離とステータスだけ)の USB シリアルのバイト列。"""
    v = dict(frame_4x4_distance_status(), seq=seq, timestamp_us=(1000 * seq) & 0xFFFFFFFF)
    return serial(build_frame(v))


def stream_vectors() -> list[dict[str, Any]]:
    """複数のメッセージを連結したバイト列と、期待する統計。

    期待値は、各ストリームの組み立て方から手で数えた値(デコーダを動かして得た値ではない)。
    """
    s1 = b"ab\x1b[2J" + b"\x00" + small_frame(0xFFFFFFFE) + small_frame(0xFFFFFFFF) + small_frame(0) + small_frame(1)
    s2 = b"\x00" + small_frame(10) + small_frame(11) + small_frame(14) + small_frame(5) + small_frame(6)
    bad21 = build_frame(dict(frame_4x4_distance_status(), seq=21, timestamp_us=21000))
    log23 = serial(build_log(dict(input_by_name("log_info"), seq=23)))
    status24 = serial(build_status(dict(input_by_name("status"), seq=24)))
    s3 = (
        b"\x00"
        + small_frame(20)
        + b"\x00"
        + serial(bad21, crc32(bad21) ^ 0x80000000)
        + b"\x05\x11\x00"
        + small_frame(22)
        + log23
        + status24
        + small_frame(25)[:5]
    )
    return [
        {
            "name": "leading_garbage_and_seq_wrap",
            "description": "6 bytes of text before the first 00, then frames with seq FFFFFFFE, FFFFFFFF, 0, 1",
            "serial_hex": s1.hex(),
            "expect": {
                "leading_bytes": 6,
                "trailing_bytes": 0,
                "empty_packets": 0,
                "accepted": 4,
                "accepted_by_type": {"frame": 4, "log": 0, "status": 0},
                "rejected": {},
                "accepted_seqs": [0xFFFFFFFE, 0xFFFFFFFF, 0, 1],
                "gaps": 0,
                "missing_messages": 0,
                "backward": 0,
            },
        },
        {
            "name": "gap_and_backward",
            "description": "seq 10, 11, 14 (2 missing), 5 (backward), 6",
            "serial_hex": s2.hex(),
            "expect": {
                "leading_bytes": 0,
                "trailing_bytes": 0,
                "empty_packets": 0,
                "accepted": 5,
                "accepted_by_type": {"frame": 5, "log": 0, "status": 0},
                "rejected": {},
                "accepted_seqs": [10, 11, 14, 5, 6],
                "gaps": 1,
                "missing_messages": 2,
                "backward": 1,
            },
        },
        {
            "name": "rejects_empty_and_partial",
            "description": (
                "frame 20, empty packet, frame 21 with bad CRC, COBS error, frame 22, log 23, status 24, "
                "then the first 5 bytes of frame 25 without a delimiter"
            ),
            "serial_hex": s3.hex(),
            "expect": {
                "leading_bytes": 0,
                "trailing_bytes": 5,
                "empty_packets": 1,
                "accepted": 4,
                "accepted_by_type": {"frame": 2, "log": 1, "status": 1},
                "rejected": {"cobs": 1, "crc": 1},
                "accepted_seqs": [20, 22, 23, 24],
                "gaps": 1,
                "missing_messages": 1,
                "backward": 0,
            },
        },
    ]


# ---------------------------------------------------------------- 出力


def expect_of(inp: dict[str, Any], payload: bytes) -> dict[str, Any]:
    """デコードした結果として期待する値(JSON 用)。"""
    common = {"type": inp["type"], "seq": inp["seq"], "timestamp_us": inp["timestamp_us"]}
    if inp["type"] == "frame":
        return {
            **common,
            "side": inp["side"],
            "targets_per_zone": inp["targets_per_zone"],
            "field_mask": inp["field_mask"],
            "temperature_c": inp["temperature_c"],
            "fields": inp["fields"],
        }
    if inp["type"] == "log":
        return {**common, "level": inp["level"], "text": printable(inp["input_text"], LOG_TEXT_MAX).decode("ascii")}
    return {
        **common,
        "side": inp["side"],
        "targets_per_zone": inp["targets_per_zone"],
        "field_mask": inp["field_mask"],
        "ranging_hz": inp["ranging_hz"],
        "flags": inp["flags"],
        "i2c_hz": inp["i2c_hz"],
        "sensor_read_bytes": inp["sensor_read_bytes"],
        "firmware_version": printable(inp["input_firmware_version"], VERSION_TEXT_MAX).decode("ascii"),
    }


def make_json() -> str:
    """docs/frame-vectors.json の内容。"""
    messages = []
    for inp in message_inputs():
        payload = payload_of(inp)
        entry: dict[str, Any] = {
            "name": inp["name"],
            "payload_hex": payload.hex(),
            "crc32": f"{crc32(payload):08x}",
            "serial_hex": serial(payload).hex(),
            "expect": expect_of(inp, payload),
        }
        if inp["type"] == "log":
            entry["input_text"] = inp["input_text"]
        if inp["type"] == "status":
            entry["input_firmware_version"] = inp["input_firmware_version"]
        messages.append(entry)
    doc = {
        "description": "Test vectors for docs/frame-format.md (format version 1). Generated by tools/gen_frame_vectors.py.",
        "format_version": VERSION,
        "crc32_check": {"input_ascii": "123456789", "crc32": f"{crc32(b'123456789'):08x}"},
        "cobs": [{"name": n, "decoded_hex": d.hex(), "encoded_hex": cobs_encode(d).hex()} for n, d in cobs_vectors()],
        "cobs_decode_only": [
            {
                "name": "run_254_with_trailing_01",
                "note": "non-canonical encoding (extra 0x01 after a full 254-byte block); decoders must accept it",
                "encoded_hex": (b"\xff" + bytes(range(1, 255)) + b"\x01").hex(),
                "decoded_hex": bytes(range(1, 255)).hex(),
            }
        ],
        "messages": messages,
        "invalid": invalid_vectors(),
        "streams": stream_vectors(),
    }
    return json.dumps(doc, indent=2) + "\n"


def c_bytes(name: str, data: bytes) -> str:
    """uint8_t の配列の定義(空なら 1 要素のダミー)。"""
    body = ", ".join(f"0x{b:02x}" for b in data) if data else "0x00"
    return f"static const uint8_t {name}[] = {{{body}}};\n"


def c_array(ctype: str, name: str, values: list[int]) -> str:
    """整数配列の定義。"""
    if ctype == "int16_t":
        body = ", ".join(f"(int16_t){v}" for v in values)
    elif ctype == "uint32_t":
        body = ", ".join(f"{v}u" for v in values)
    else:
        body = ", ".join(str(v) for v in values)
    return f"static const {ctype} {name}[] = {{{body}}};\n"


def c_string(s: str) -> str:
    """C の文字列リテラル(ASCII の英数字と記号だけを想定)。"""
    assert all(0x20 <= ord(c) <= 0x7E and c not in '"\\' for c in s), s
    return f'"{s}"'


def make_header() -> str:
    """tests/frame_vectors.h の内容。"""
    out = [
        "/* SPDX-License-Identifier: MIT */\n",
        "/* tools/gen_frame_vectors.py が生成したファイル。手で編集しない(docs/frame-vectors.json と同じ内容) */\n",
        "// clang-format off\n",
        "#ifndef FRAME_VECTORS_H\n#define FRAME_VECTORS_H\n\n#include <stddef.h>\n#include <stdint.h>\n\n",
        "typedef struct {\n  const char *name;\n  const uint8_t *decoded;\n  size_t decoded_len;\n"
        "  const uint8_t *encoded;\n  size_t encoded_len;\n} fv_cobs_t;\n\n",
        "typedef struct {\n  const char *name;\n  uint8_t type;\n  uint32_t seq;\n  uint32_t timestamp_us;\n"
        "  uint8_t side;\n  uint8_t targets_per_zone;\n  uint16_t field_mask;\n  int8_t temperature_c;\n"
        "  const int16_t *distance_mm;\n  const uint8_t *target_status;\n  const uint16_t *range_sigma_mm;\n"
        "  const uint8_t *nb_target_detected;\n  const uint32_t *signal_per_spad;\n  const uint32_t *nb_spads_enabled;\n  uint8_t level;\n"
        "  const char *text;\n  uint8_t ranging_hz;\n  uint8_t flags;\n  uint32_t i2c_hz;\n"
        "  uint32_t sensor_read_bytes;\n  const char *firmware_version;\n  const uint8_t *payload;\n"
        "  size_t payload_len;\n  uint32_t crc32;\n  const uint8_t *serial;\n  size_t serial_len;\n} fv_message_t;\n\n",
    ]
    cobs_rows = []
    for i, (n, d) in enumerate(cobs_vectors()):
        out.append(c_bytes(f"fv_cobs_dec_{i}", d))
        out.append(c_bytes(f"fv_cobs_enc_{i}", cobs_encode(d)))
        cobs_rows.append(f'  {{"{n}", fv_cobs_dec_{i}, {len(d)}u, fv_cobs_enc_{i}, {len(cobs_encode(d))}u}},\n')
    out.append("\nstatic const fv_cobs_t FV_COBS[] = {\n" + "".join(cobs_rows) + "};\n\n")

    msg_rows = []
    types = {"frame": 1, "log": 2, "status": 3}
    ctypes = {
        "distance_mm": "int16_t",
        "target_status": "uint8_t",
        "range_sigma_mm": "uint16_t",
        "nb_target_detected": "uint8_t",
        "signal_per_spad": "uint32_t",
        "nb_spads_enabled": "uint32_t",
    }
    for i, inp in enumerate(message_inputs()):
        payload = payload_of(inp)
        ser = serial(payload)
        out.append(c_bytes(f"fv_msg_payload_{i}", payload))
        out.append(c_bytes(f"fv_msg_serial_{i}", ser))
        ptrs = {k: "NULL" for k in ctypes}
        if inp["type"] == "frame":
            for k, values in inp["fields"].items():
                out.append(c_array(ctypes[k], f"fv_msg_{k}_{i}", values))
                ptrs[k] = f"fv_msg_{k}_{i}"
        g = inp.get
        msg_rows.append(
            f'  {{"{inp["name"]}", {types[inp["type"]]}u, {inp["seq"]}u, {inp["timestamp_us"]}u, {g("side", 0)}u, '
            f'{g("targets_per_zone", 0)}u, {g("field_mask", 0)}u, {g("temperature_c", 0)}, '
            f'{ptrs["distance_mm"]}, {ptrs["target_status"]}, {ptrs["range_sigma_mm"]}, '
            f'{ptrs["nb_target_detected"]}, {ptrs["signal_per_spad"]}, {ptrs["nb_spads_enabled"]}, {g("level", 0)}u, '
            f'{c_string(inp["input_text"]) if "input_text" in inp else "NULL"}, {g("ranging_hz", 0)}u, '
            f'{g("flags", 0)}u, {g("i2c_hz", 0)}u, {g("sensor_read_bytes", 0)}u, '
            f'{c_string(inp["input_firmware_version"]) if "input_firmware_version" in inp else "NULL"}, '
            f"fv_msg_payload_{i}, {len(payload)}u, 0x{crc32(payload):08x}u, fv_msg_serial_{i}, {len(ser)}u}},\n"
        )
    out.append("\nstatic const fv_message_t FV_MESSAGES[] = {\n" + "".join(msg_rows) + "};\n\n")
    out.append(f"#define FV_CRC32_CHECK 0x{crc32(b'123456789'):08x}u\n\n")
    out.append("#endif // FRAME_VECTORS_H\n// clang-format on\n")
    return "".join(out)


def main() -> int:
    """ファイルを書き直す、または --check で一致を確かめる。"""
    # Windows のコンソールでも --help などの日本語が化けないように、出力を UTF-8 にする
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="書き直さずに、今のファイルと一致するかだけ確かめる")
    args = parser.parse_args()
    assert crc32(b"123456789") == 0xCBF43926
    outputs = {JSON_PATH: make_json(), HEADER_PATH: make_header()}
    if args.check:
        stale = [p for p, text in outputs.items() if not p.exists() or p.read_text(encoding="utf-8") != text]
        for p in stale:
            print(f"out of date: {p.relative_to(ROOT)} (run: python tools/gen_frame_vectors.py)", file=sys.stderr)
        return 1 if stale else 0
    for p, text in outputs.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {p.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
