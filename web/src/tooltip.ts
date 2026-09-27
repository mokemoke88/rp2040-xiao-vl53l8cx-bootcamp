/**
 * ゾーンの値を出すツールチップの配置と文言。DOM に依存しない(main.ts が要素に反映する)。
 */

import type { RangingFrame } from "./frame.ts";
import { describeZone } from "./view.ts";

/** カーソルからツールチップまでの距離 [CSS px] */
export const TOOLTIP_OFFSET_PX = 14;
/** 画面の端から空ける幅 [CSS px] */
const EDGE_MARGIN_PX = 4;

/**
 * ツールチップの左上の位置を決める。カーソルの右下に置き、画面の右端・下端からはみ出すなら左・上に反転する。
 * 反転してもはみ出すとき(ツールチップが画面より大きいなど)は、画面の左上の端に寄せる。
 *
 * @param clientX - カーソルの x(ビューポート座標 [CSS px])
 * @param clientY - カーソルの y
 * @param width - ツールチップの幅 [CSS px]
 * @param height - ツールチップの高さ [CSS px]
 * @param viewportWidth - ビューポートの幅 [CSS px]
 * @param viewportHeight - ビューポートの高さ [CSS px]
 * @returns position: fixed の left / top [CSS px]
 */
export function placeTooltip(
  clientX: number,
  clientY: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const place = (cursor: number, size: number, viewport: number): number => {
    const after = cursor + TOOLTIP_OFFSET_PX;
    if (after + size <= viewport - EDGE_MARGIN_PX) {
      return after;
    }
    const before = cursor - TOOLTIP_OFFSET_PX - size;
    return Math.max(EDGE_MARGIN_PX, before);
  };
  return {
    left: place(clientX, width, viewportWidth),
    top: place(clientY, height, viewportHeight),
  };
}

/**
 * ツールチップの行: 見出し(どの図か)、ゾーンの全フィールド(view.ts の describeZone)、図ごとの補足。
 *
 * @param title - どの図に乗せているか
 * @param frame - 値を取る測距フレーム(null なら「フレーム待ち」)
 * @param zone - ゾーンの番号
 * @param extra - 補足の行(何フレーム前の値か、真上から見た位置など)
 */
export function tooltipLines(
  title: string,
  frame: RangingFrame | null,
  zone: number,
  extra: readonly string[] = [],
): string[] {
  if (frame === null) {
    return [title, "フレーム待ち"];
  }
  return [title, ...describeZone(frame, zone), ...extra];
}
