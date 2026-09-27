# SPDX-License-Identifier: MIT
"""XIAO の USB シリアルをバイナリモードにして、受信したバイト列をそのままファイルに記録する。

1. ポートを DTR = True で開く(Pico SDK の USB CDC は DTR が立たないと出力しない)
2. 'b' を送ってバイナリモードにする(ファームウェアは区切りの 0x00 → 状態メッセージ → 測距フレーム の順に送る)
3. --seconds 秒のあいだ受信したバイト列を記録する
4. 記録を止めてから 't' を送ってテキスト表示に戻す(--keep-binary で送らない)

記録は tools/verification/decode_capture.py でデコードできる。pyserial が要る(リポジトリルートの .venv に入っている)。

例(ワークスペース直下で):
    python tools/capture_serial.py --port COM7 --seconds 5 --out capture.bin
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import serial  # pyserial


def capture(port: str, seconds: float, out: Path, keep_binary: bool) -> int:
    """port を開いて seconds 秒記録し、out に書く。記録したバイト数を返す。"""
    with serial.Serial() as ser:
        ser.port = port
        ser.baudrate = 115200  # USB CDC なので値は通信速度に関係しない
        ser.timeout = 0.05
        ser.dtr = True
        ser.open()
        time.sleep(0.2)
        ser.reset_input_buffer()  # テキスト表示の残りを捨てる(ファームウェアはバイナリの前に 0x00 を送るので必須ではない)
        ser.write(b"b")
        ser.flush()
        data = bytearray()
        end = time.monotonic() + seconds
        try:
            while time.monotonic() < end:
                data += ser.read(4096)
        except KeyboardInterrupt:
            # Ctrl-C で止めた場合も、それまでに記録した分を書き出す
            print("interrupted; saving what was recorded", file=sys.stderr)
        finally:
            out.write_bytes(bytes(data))
            if not keep_binary:
                ser.write(b"t")
                ser.flush()
    return len(data)


def main() -> int:
    """コマンドラインの入口。"""
    # Windows のコンソールでも --help などの日本語が化けないように、出力を UTF-8 にする
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="record the XIAO USB serial in binary mode")
    parser.add_argument("--port", required=True, help="シリアルポート(例 COM7)")
    parser.add_argument("--seconds", type=float, default=5.0, help="記録する秒数(既定 5)")
    parser.add_argument("--out", type=Path, required=True, help="出力ファイル")
    parser.add_argument("--keep-binary", action="store_true", help="終了時に 't' を送らない(バイナリモードのまま)")
    args = parser.parse_args()
    n = capture(args.port, args.seconds, args.out, args.keep_binary)
    print(f"wrote {n} bytes to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
