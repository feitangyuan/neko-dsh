import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { EYE, EYES, GRID, MOUTH, RING, SOLID, pupilAt } from "../kernel/nekoArt";

/**
 * 活的猫脸。像素画来自 `kernel/nekoArt`，和 app 图标同一份，所以哪儿画都长一样。
 *
 * 活在两件事上：随机眨眼，以及眼珠按 3×3 像素格跟着光标走（xeyes 传统）。
 * 两处在用——标题栏左上角那对窗控，和空会话中间那只——所以拆出来放这儿；
 * 调用方给颜色和倍率，覆盖层（比如窗控的两个热区）当 children 传进来。
 */

/** 眼睛画在半格上：一个像素格 = 2×2 半格 */
const UNIT = EYE.unit;
/* 画布四边各留 1px 空白，画在界面里的时候那圈空白没用，裁掉。 */
export const NEKO_CROP = 1;
const CROP = NEKO_CROP;
export const NEKO_SPAN = GRID - CROP * 2;

interface Props {
  /** 一个像素格几个屏幕点。取整数，半格才落在整点上，不然糊。 */
  scale: number;
  /** 线条色（轮廓、嘴、眼眶、眼珠） */
  ink: string;
  /** 面色（脸）。取所在背景的颜色，脸就等于隐形，只剩线条——图标和空会话都是这样。 */
  paper: string;
  /** 眼白。默认跟脸同色；脸要融进底色时（比如条纹标题栏）单给一个白，眼睛才立得住。 */
  sclera?: string;
  /** 给了就是 hover 时整只眼睛换成这两张 6×6 符号图，左眼一张右眼一张 */
  hoverEyes?: readonly [readonly string[], readonly string[]];
  children?: ReactNode;
}

export function NekoFace({ scale, ink, paper, sclera, hoverEyes, children }: Props) {
  const [hover, setHover] = useState(false);
  const [blink, setBlink] = useState(false);
  /* 静止时眼珠朝右下——app 图标就是这一帧，两处得对得上 */
  const [gaze, setGaze] = useState<[number, number]>([1, 1]);
  const ref = useRef<HTMLDivElement>(null);
  const gazeRef = useRef<[number, number]>([1, 1]);

  /* 眨眼：每 2.6–5s 一次，闭 160ms */
  useEffect(() => {
    let timer: number;
    let reopen: number;
    const loop = () => {
      setBlink(true);
      reopen = window.setTimeout(() => setBlink(false), 160);
      timer = window.setTimeout(loop, 2600 + Math.random() * 2400);
    };
    timer = window.setTimeout(loop, 2000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(reopen);
    };
  }, []);

  /* 视线跟随：量化到 3×3 像素格，格子变化才触发渲染 */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const q: [number, number] = [
        Math.max(-1, Math.min(1, Math.round(dx / 72))),
        Math.max(-1, Math.min(1, Math.round(dy / 72))),
      ];
      if (q[0] !== gazeRef.current[0] || q[1] !== gazeRef.current[1]) {
        gazeRef.current = q;
        setGaze(q);
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  const white = sclera ?? paper;

  /** 眼睛里的某一半格填什么色。dy/dx 是 6×6 半格里的坐标。 */
  const eyeFill = (index: number, dy: number, dx: number): string => {
    if (hover && hoverEyes) return hoverEyes[index][dy][dx] === "#" ? ink : paper; // 眼眶也让位给符号
    if (EYE.frame[dy][dx] === "#") return ink; // 眼眶
    if (EYE.frame[dy][dx] === ".") {
      if (blink) return dy === 2 || dy === 3 ? ink : white; // 闭上的眼睛是一道横线
      const [py, px] = pupilAt(gaze);
      const inPupil = dy >= py && dy < py + EYE.pupil && dx >= px && dx < px + EYE.pupil;
      return inPupil ? ink : white;
    }
    return paper; // 眼角切掉的那四格：留给脸
  };

  /* 整张脸按半格画：一个像素格 = 2×2 半格。头和嘴还是整格填，
     只有眼睛用得上这一层精度——眼珠要在眼眶里挪得开。 */
  const cells: ReactElement[] = [];
  for (let y = CROP * UNIT; y < (GRID - CROP) * UNIT; y += 1) {
    for (let x = CROP * UNIT; x < (GRID - CROP) * UNIT; x += 1) {
      const cellY = Math.floor(y / UNIT);
      const cellX = Math.floor(x / UNIT);
      const key = `${cellY}:${cellX}`;
      const eye = EYES.findIndex(
        (e) => cellY >= e.row && cellY < e.row + 3 && cellX >= e.col && cellX < e.col + 3
      );
      let fill: string;
      if (eye !== -1) {
        fill = eyeFill(eye, y - EYES[eye].row * UNIT, x - EYES[eye].col * UNIT);
      } else if (RING.has(key) || MOUTH.has(key)) fill = ink;
      else if (SOLID.has(key)) fill = paper;
      else continue; // 猫外面：透明，让底下的东西透过去
      cells.push(<rect key={`${y}:${x}`} x={x} y={y} width={1} height={1} fill={fill} />);
    }
  }

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative"
      style={{ width: NEKO_SPAN * scale, height: NEKO_SPAN * scale }}
    >
      <svg
        viewBox={`${CROP * UNIT} ${CROP * UNIT} ${NEKO_SPAN * UNIT} ${NEKO_SPAN * UNIT}`}
        width={NEKO_SPAN * scale}
        height={NEKO_SPAN * scale}
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {cells}
      </svg>
      {children}
    </div>
  );
}
