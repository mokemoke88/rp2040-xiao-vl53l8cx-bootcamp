# SPDX-License-Identifier: MIT
"""USB シリアルの記録(tools/capture_serial.py の出力)を docs/frame-format.md に従ってデコードし、統計を出す。

C の実装(src/frame_proto.c)ともテストベクタの生成スクリプト(tools/gen_frame_vectors.py)とも別に書いた
デコーダ。CRC-32 は標準ライブラリの zlib.crc32 を使う。起動時にまず docs/frame-vectors.json で自己検査し、
一致しなければ記録のデコードはしない。

使い方(ワークスペース直下で):
    python tools/verification/decode_capture.py capture.bin           # 自己検査 + デコードと統計
    python tools/verification/decode_capture.py capture.bin --show 3  # 先頭 3 フレームの中身も出す
    python tools/verification/decode_capture.py --self-test           # 自己検査だけ(make test で使う)
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
VECTORS = ROOT / "docs" / "frame-vectors.json"
SPEC = ROOT / "docs" / "frame-format.md"

# フィールド: (ビット, 名前, struct の書式 1 要素, ターゲットごとか)
FIELDS = [
    (0, "distance_mm", "h", True),
    (1, "target_status", "B", True),
    (2, "range_sigma_mm", "H", True),
    (3, "nb_target_detected", "B", False),
    (4, "signal_per_spad", "I", True),
    (5, "nb_spads_enabled", "I", False),
]
KNOWN_MASK = 0x3F


class Reject(Exception):
    """受信側が拒否すべきパケット。args[0] は理由(テストベクタの "reject" と同じ語)。"""


def cobs_decode(data: bytes) -> bytes:
    """区切りを含まない 1 パケットを COBS デコードする。不正なら Reject("cobs")。"""
    if not data:
        raise Reject("cobs")
    out = bytearray()
    i = 0
    while i < len(data):
        code = data[i]
        i += 1
        if code == 0 or i + code - 1 > len(data):
            raise Reject("cobs")
        chunk = data[i : i + code - 1]
        if 0 in chunk:
            raise Reject("cobs")
        out += chunk
        i += code - 1
        if code != 0xFF and i < len(data):
            out.append(0)
    return bytes(out)


def parse_payload(p: bytes) -> dict[str, Any]:
    """ペイロードを検証して辞書にする。不正なら理由付きで Reject。"""
    if len(p) < 12:
        raise Reject("length")
    if p[0:2] != b"V8":
        raise Reject("magic")
    version, msg_type, seq, ts = struct.unpack_from("<BBII", p, 2)
    if version != 1:
        raise Reject("version")
    common: dict[str, Any] = {"seq": seq, "timestamp_us": ts}
    if msg_type == 1:
        if len(p) < 18:
            raise Reject("length")
        side, targets, mask, temp, reserved = struct.unpack_from("<BBHbB", p, 12)
        if side not in (4, 8) or not 1 <= targets <= 4 or mask & ~KNOWN_MASK or reserved != 0:
            raise Reject("frame_header")
        zones = side * side
        off = 18
        fields: dict[str, list[int]] = {}
        for bit, name, fmt, per_target in FIELDS:
            if not mask & (1 << bit):
                continue
            count = zones * targets if per_target else zones
            size = struct.calcsize("<" + fmt) * count
            if off + size > len(p):
                raise Reject("length")
            fields[name] = list(struct.unpack_from(f"<{count}{fmt}", p, off))
            off += size
        if off != len(p):
            raise Reject("length")
        return {"type": "frame", **common, "side": side, "targets_per_zone": targets, "field_mask": mask,
                "temperature_c": temp, "fields": fields}
    if msg_type == 2:
        if len(p) < 16:
            raise Reject("length")
        level, reserved, n = struct.unpack_from("<BBH", p, 12)
        if level > 2 or reserved != 0:
            raise Reject("log")
        if len(p) != 16 + n:
            raise Reject("length")
        return {"type": "log", **common, "level": level, "text": p[16:].decode("ascii", errors="replace")}
    if msg_type == 3:
        if len(p) < 27:
            raise Reject("length")
        side, targets, mask, hz, flags, i2c_hz, read_bytes, n = struct.unpack_from("<BBHBBIIB", p, 12)
        if side not in (4, 8) or not 1 <= targets <= 4 or mask & ~KNOWN_MASK:
            raise Reject("status")
        if flags & ~0x03:
            raise Reject("status")
        if len(p) != 27 + n:
            raise Reject("length")
        return {"type": "status", **common, "side": side, "targets_per_zone": targets, "field_mask": mask,
                "ranging_hz": hz, "flags": flags, "i2c_hz": i2c_hz, "sensor_read_bytes": read_bytes,
                "firmware_version": p[27:].decode("ascii", errors="replace")}
    raise Reject("type")


def decode_packet(packet: bytes) -> dict[str, Any]:
    """区切りを含まない 1 パケット(COBS)をデコードし、CRC を確かめてペイロードを解析する。"""
    raw = cobs_decode(packet)
    if len(raw) < 4:
        raise Reject("length")
    payload, crc = raw[:-4], struct.unpack("<I", raw[-4:])[0]
    if zlib.crc32(payload) != crc:
        raise Reject("crc")
    return parse_payload(payload)


def split_packets(data: bytes) -> tuple[bytes, list[bytes], bytes]:
    """0x00 で区切る。(最初の区切りより前、区切られたパケットの列、最後の区切りより後)を返す。"""
    parts = data.split(b"\x00")
    if len(parts) == 1:
        return data, [], b""
    return parts[0], parts[1:-1], parts[-1]


# ---------------------------------------------------------------- 自己検査


def self_test(path: Path = VECTORS) -> list[str]:
    """テストベクタでデコーダを検査する。失敗の説明の一覧を返す(空なら合格)。"""
    v = json.loads(path.read_text(encoding="utf-8"))
    errors: list[str] = []
    if v.get("format_version") != 1:
        errors.append("format_version is not 1")
    check = v["crc32_check"]
    if zlib.crc32(check["input_ascii"].encode()) != int(check["crc32"], 16):
        errors.append("crc32 check value")
    for c in v["cobs"] + v["cobs_decode_only"]:
        try:
            if cobs_decode(bytes.fromhex(c["encoded_hex"])) != bytes.fromhex(c["decoded_hex"]):
                errors.append(f"cobs {c['name']}: decoded bytes differ")
        except Reject:
            errors.append(f"cobs {c['name']}: rejected")
    for m in v["messages"]:
        ser = bytes.fromhex(m["serial_hex"])
        if not ser.endswith(b"\x00") or ser.count(0) != 1:
            errors.append(f"message {m['name']}: serial must contain exactly one 0x00 at the end")
            continue
        try:
            got = decode_packet(ser[:-1])
        except Reject as e:
            errors.append(f"message {m['name']}: rejected ({e.args[0]})")
            continue
        if got != m["expect"]:
            errors.append(f"message {m['name']}: decoded fields differ")
        if zlib.crc32(bytes.fromhex(m["payload_hex"])) != int(m["crc32"], 16):
            errors.append(f"message {m['name']}: crc32 field")
    for bad in v["invalid"]:
        ser = bytes.fromhex(bad["serial_hex"])
        _, packets, tail = split_packets(b"\x00" + ser)
        if tail:
            errors.append(f"invalid {bad['name']}: must end with 0x00")
            continue
        if bad["reject"] == "ignore":
            if any(packets):
                errors.append(f"invalid {bad['name']}: expected only empty packets")
            continue
        try:
            decode_packet(packets[0])
            errors.append(f"invalid {bad['name']}: accepted (expected reject {bad['reject']})")
        except Reject as e:
            if e.args[0] != bad["reject"]:
                errors.append(f"invalid {bad['name']}: rejected as {e.args[0]}, expected {bad['reject']}")
    for stream in v["streams"]:
        got = analyze(bytes.fromhex(stream["serial_hex"])).summary()
        if got != stream["expect"]:
            errors.append(f"stream {stream['name']}: statistics differ: got {got}, expected {stream['expect']}")
    errors += check_spec_example(v)
    return errors


def check_spec_example(v: dict[str, Any], spec: Path = SPEC) -> list[str]:
    """仕様書に手で書いた 16 進の例(example ブロック)が、テストベクタと一致するかを確かめる。"""
    errors: list[str] = []
    text = spec.read_text(encoding="utf-8")
    blocks = re.findall(r"<!-- example:(\w+):(\w+) -->\s*```text\n(.*?)```", text, flags=re.S)
    if not blocks:
        return ["spec example: no example block found in docs/frame-format.md"]
    for name, kind, body in blocks:
        m = next((x for x in v["messages"] if x["name"] == name), None)
        if m is None:
            errors.append(f"spec example {name}: no such message vector")
            continue
        tokens = [t for line in body.splitlines() for t in line.split("#", 1)[0].split()]
        got = bytes(int(t, 16) for t in tokens)
        if kind == "packet":
            want = bytes.fromhex(m["payload_hex"]) + int(m["crc32"], 16).to_bytes(4, "little")
        else:
            want = bytes.fromhex(m["serial_hex"])
        if got != want:
            errors.append(f"spec example {name}:{kind}: bytes differ from the vector")
    return errors


# ---------------------------------------------------------------- 記録の統計


@dataclass
class Stats:
    """記録のデコード結果の集計。"""

    total_bytes: int = 0
    leading_bytes: int = 0
    trailing_bytes: int = 0
    empty_packets: int = 0
    rejects: dict[str, int] = field(default_factory=dict)
    by_type: dict[str, int] = field(default_factory=dict)
    seq_gaps: int = 0
    missing_messages: int = 0
    seq_backward: int = 0
    frame_ts: list[int] = field(default_factory=list)
    logs: list[dict[str, Any]] = field(default_factory=list)
    statuses: list[dict[str, Any]] = field(default_factory=list)
    frames: list[dict[str, Any]] = field(default_factory=list)
    accepted_seqs: list[int] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        """テストベクタの streams の expect と同じ形の辞書。"""
        return {
            "leading_bytes": self.leading_bytes,
            "trailing_bytes": self.trailing_bytes,
            "empty_packets": self.empty_packets,
            "accepted": len(self.accepted_seqs),
            "accepted_by_type": {t: self.by_type.get(t, 0) for t in ("frame", "log", "status")},
            "rejected": dict(sorted(self.rejects.items())),
            "accepted_seqs": self.accepted_seqs,
            "gaps": self.seq_gaps,
            "missing_messages": self.missing_messages,
            "backward": self.seq_backward,
        }


def analyze(data: bytes) -> Stats:
    """記録のバイト列をデコードして集計する。"""
    st = Stats(total_bytes=len(data))
    leading, packets, trailing = split_packets(data)
    st.leading_bytes, st.trailing_bytes = len(leading), len(trailing)
    prev_seq: int | None = None
    for pkt in packets:
        if not pkt:
            st.empty_packets += 1
            continue
        try:
            msg = decode_packet(pkt)
        except Reject as e:
            # 拒否しても prev_seq は変えない(欠落は「最後に受け付けた seq」との差で数える。docs/frame-format.md)
            st.rejects[e.args[0]] = st.rejects.get(e.args[0], 0) + 1
            continue
        st.by_type[msg["type"]] = st.by_type.get(msg["type"], 0) + 1
        if prev_seq is not None:
            gap = (msg["seq"] - prev_seq - 1) & 0xFFFFFFFF
            if gap >= 0x80000000:
                # 2^31 以上先へ飛んだのは、実際には戻った(送信側の再起動や記録の継ぎ目)とみなし、欠落に数えない
                st.seq_backward += 1
            elif gap:
                st.seq_gaps += 1
                st.missing_messages += gap
        prev_seq = msg["seq"]
        st.accepted_seqs.append(msg["seq"])
        if msg["type"] == "frame":
            st.frame_ts.append(msg["timestamp_us"])
            st.frames.append(msg)
        elif msg["type"] == "log":
            st.logs.append(msg)
        else:
            st.statuses.append(msg)
    return st


def report(st: Stats, show: int) -> None:
    """統計を表示する。"""
    print(f"bytes: {st.total_bytes} (before first 0x00: {st.leading_bytes}, after last 0x00: {st.trailing_bytes})")
    print(f"messages: {st.by_type}  empty packets: {st.empty_packets}")
    print(f"rejected: {sum(st.rejects.values())} {st.rejects}")
    print(f"sequence gaps: {st.seq_gaps} (missing messages: {st.missing_messages}), went backward: {st.seq_backward}")
    ts = st.frame_ts
    if len(ts) >= 2:
        diffs = [(b - a) & 0xFFFFFFFF for a, b in zip(ts, ts[1:])]
        span = sum(diffs)
        print(f"frames: {len(ts)}  fps: {(len(ts) - 1) * 1e6 / span:.2f}  "
              f"interval us: min {min(diffs)} max {max(diffs)} mean {span / len(diffs):.0f}")
    else:
        print(f"frames: {len(ts)}")
    for s in st.statuses:
        print(f"status seq {s['seq']}: {s['side']}x{s['side']} targets {s['targets_per_zone']} "
              f"mask 0x{s['field_mask']:04x} {s['ranging_hz']} Hz flags 0x{s['flags']:02x} i2c {s['i2c_hz']} Hz "
              f"read {s['sensor_read_bytes']} B fw '{s['firmware_version']}'")
    for lg in st.logs:
        print(f"log seq {lg['seq']} level {lg['level']}: {lg['text']}")
    for fr in st.frames[:show]:
        f = fr["fields"]
        print(f"frame seq {fr['seq']} ts {fr['timestamp_us']} temp {fr['temperature_c']}C mask 0x{fr['field_mask']:04x}")
        for name, values in f.items():
            print(f"  {name}: {values}")


def main() -> int:
    """コマンドラインの入口。"""
    # Windows のコンソールでも --help などの日本語が化けないように、出力を UTF-8 にする
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="decode a USB serial capture (docs/frame-format.md)")
    parser.add_argument("capture", nargs="?", type=Path, help="記録ファイル(tools/capture_serial.py の出力)")
    parser.add_argument("--self-test", action="store_true", help="テストベクタでの自己検査だけ行う")
    parser.add_argument("--show", type=int, default=0, help="先頭から中身を表示するフレーム数")
    args = parser.parse_args()

    errors = self_test()
    if errors:
        for e in errors:
            print(f"SELF-TEST FAIL: {e}", file=sys.stderr)
        return 1
    print(f"self-test OK ({VECTORS.relative_to(ROOT)})")
    if args.self_test:
        return 0
    if args.capture is None:
        parser.error("capture file is required unless --self-test")
    report(analyze(args.capture.read_bytes()), args.show)
    return 0


if __name__ == "__main__":
    sys.exit(main())
