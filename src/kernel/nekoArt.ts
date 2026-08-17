import art from "./nekoArt.json";

/**
 * Neko 的脸，一份像素画两处用：app 图标（`scripts/make-icons.mjs`）和标题栏
 * 左上角那对窗控。两边读同一个 JSON，所以图标和窗口里的猫不可能长得不一样。
 *
 * 轮廓是**算出来的**，不是画出来的：形状里凡是挨着外面的格子就是描边。
 * 手画轮廓的话，脸上任何一个镂空（嘴、眼睛）都会被当成边界再描一圈——
 * 上一版的怪嘴就是这么来的。
 */

const at = (row: number, col: number) => `${row}:${col}`;

/** 猫占的所有格子（实心，脸上的五官不在这里挖洞） */
export const SOLID = new Set<string>();
art.head.forEach((row, y) => [...row].forEach((cell, x) => cell === "#" && SOLID.add(at(y, x))));

export const RING = new Set<string>();
for (const key of SOLID) {
  const [y, x] = key.split(":").map(Number);
  const open = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([dy, dx]) => !SOLID.has(at(y + dy, x + dx)));
  if (open) RING.add(key);
}

export const MOUTH = new Set(art.mouth.map(([y, x]) => at(y, x)));

/** 两只眼睛在像素格里的左上角，每只 3×3 */
export const EYES = art.eyes;

/**
 * 眼睛画在**半格**上（`unit = 2`，一个像素格 = 2×2 半格），所以 3×3 的眼位里
 * 装得下 6×6：一圈眼眶 + 4×4 眼白 + 2×2 眼珠。眼珠在眼白里有三档位移，
 * 这才是「眼珠跟着鼠标」看得出来的原因——整只眼涂黑的话动多少都是一坨黑。
 */
export const EYE = art.eye;

/** 眼珠左上角在 6×6 半格里的位置。gaze 的两个分量都是 -1 / 0 / 1。 */
export function pupilAt(gaze: readonly [number, number]): [number, number] {
  return [1 + gaze[1] + 1, 1 + gaze[0] + 1];
}

export const GRID = art.head.length;
