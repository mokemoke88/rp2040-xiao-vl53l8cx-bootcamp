# SPDX-License-Identifier: MIT
# tests/test_depth_view.c の期待値を検算する: 距離の段階(depth_view_level)の境界と、
# 4x4 のモノクロ表示の期待文字列(test_render_mono_4x4_exact)。段階の式は include/depth_view.h のとおり
# level = d * LEVELS // (range_max + 1)(d > range_max は範囲外 = LEVELS)。
from fractions import Fraction

LEVELS = 8
RAMP = "@%#*+=-:."  # 添字が段階。最後は範囲外


def level(d, range_max):
    d = max(d, 0)
    if d > range_max:
        return LEVELS
    # 厳密な有理数で計算して切り捨てる(C の整数除算と一致するか確かめるため)
    return int(Fraction(d * LEVELS, range_max + 1))


def main():
    rm = 2000
    print("level boundaries for range_max = 2000:")
    for lv in range(LEVELS):
        first = min(d for d in range(0, rm + 1) if level(d, rm) == lv)
        last = max(d for d in range(0, rm + 1) if level(d, rm) == lv)
        print(f"  level {lv}: {first}..{last}")
    for d in (0, 250, 251, 1750, 1751, 2000, 2001, -5):
        print(f"  level({d}, 2000) = {level(d, rm)}")
    print(f"  level(0, 0) = {level(0, 0)}, level(1, 0) = {level(1, 0)}")
    print(f"  level(32767, 65535) = {level(32767, 65535)}")

    # 4x4 のモノクロ表示: zone i の距離 = i * 100 mm。zone 5 = ステータス無効 'x'、6 = sigma 超過 '?'、7 = ターゲットなし ' '
    print("expected 4x4 mono rows (cells only):")
    for row in range(4):
        cells = []
        for col in range(4):
            z = row * 4 + col
            if z == 5:
                cells.append(" x   ")
            elif z == 6:
                cells.append(" ?   ")
            elif z == 7:
                cells.append("     ")
            else:
                d = z * 100
                cells.append(" " + RAMP[level(d, rm)] + f"{d // 10:3d}")
        print('  "' + "".join(cells) + '"')


if __name__ == "__main__":
    main()
