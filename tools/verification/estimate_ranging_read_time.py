# SPDX-License-Identifier: MIT
# README の「8x8 / 15 Hz の読み出し時間の見積もり」の検算: vl53l8cx_get_ranging_data が 1 フレームで I2C から読む
# バイト数(ULD の data_read_size)と、その I2C 転送にかかる時間を計算する。
# data_read_size の計算は third_party/vl53l8cx_uld/src/vl53l8cx_api.c の vl53l8cx_start_ranging と同じ。
# ブロックヘッダの値は vl53l8cx_api.h(VL53L8CX_NB_TARGET_PER_ZONE == 1 の場合)、有効な出力は include/platform.h。
from fractions import Fraction

NB_TARGET_PER_ZONE = 1
# (名前, ブロックヘッダ, output_bh_enable のビット, 有効か)
OUTPUTS = [
    ("START", 0x0000000D, 0, True),
    ("METADATA", 0x54B400C0, 1, True),
    ("COMMONDATA", 0x54C00040, 2, True),
    ("AMBIENT_RATE", 0x54D00104, 3, False),        # VL53L8CX_DISABLE_AMBIENT_PER_SPAD
    ("SPAD_COUNT", 0x55D00404, 4, False),          # VL53L8CX_DISABLE_NB_SPADS_ENABLED
    ("NB_TARGET_DETECTED", 0xDB840401, 5, True),
    ("SIGNAL_RATE", 0xDBC40404, 6, False),         # VL53L8CX_DISABLE_SIGNAL_PER_SPAD
    ("RANGE_SIGMA_MM", 0xDEC40402, 7, True),
    ("DISTANCE", 0xDF440402, 8, True),
    ("REFLECTANCE", 0xE0440401, 9, False),         # VL53L8CX_DISABLE_REFLECTANCE_PERCENT
    ("TARGET_STATUS", 0xE0840401, 10, True),
    ("MOTION_DETECT", 0xD85808C0, 11, False),      # VL53L8CX_DISABLE_MOTION_INDICATOR
]

# i2c_set_baudrate の戻り値(clk_sys 125 MHz、要求 400 kHz)
I2C_HZ = 125_000_000 // ((125_000_000 + 400_000 // 2) // 400_000)


def data_read_size(resolution):
    size = 0
    for _name, bh, _bit, enabled in OUTPUTS:
        if not enabled or bh == 0:
            continue
        typ = bh & 0xF
        bsize = (bh >> 4) & 0xFFF
        idx = (bh >> 16) & 0xFFFF
        if 0x1 <= typ < 0xD:
            if 0x54D0 <= idx < 0x54D0 + 960:
                bsize = resolution
            else:
                bsize = resolution * NB_TARGET_PER_ZONE
            size += typ * bsize
        else:
            size += bsize
        size += 4
    return size + 24


def transfer_bits(read_bytes):
    # RdMulti: [START アドレス(W) レジスタ上位 レジスタ下位] [RESTART アドレス(R) データ × n] STOP
    # 1 バイト = 8 bit + ACK/NACK の 9 クロック。START / RESTART / STOP の時間は無視する
    return (3 + 1 + read_bytes) * 9


def main():
    print(f"I2C clock: {I2C_HZ} Hz")
    for name, res, hz in (("4x4", 16, 10), ("8x8", 64, 15)):
        n = data_read_size(res)
        t_ms = Fraction(transfer_bits(n) * 1000, I2C_HZ)
        period_ms = Fraction(1000, hz)
        print(f"{name}: data_read_size = {n} bytes, transfer >= {float(t_ms):.2f} ms"
              f" ({float(t_ms / period_ms * 100):.1f}% of {float(period_ms):.1f} ms at {hz} Hz)")
    poll_ms = Fraction(transfer_bits(4) * 1000, I2C_HZ)
    print(f"check_data_ready (4 bytes): transfer >= {float(poll_ms):.3f} ms")


if __name__ == "__main__":
    main()
