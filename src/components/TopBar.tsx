import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/runtime";
import { EYES } from "../kernel/nekoArt";
import { NEKO_CROP, NEKO_SPAN, NekoFace } from "./NekoFace";

interface Props {
  sessionTitle: string;
  contentOffset: number; // 侧栏宽度：标题居中于内容区而非整个窗口
  rightOffset: number; // 预览面板宽度：同步校正标题居中
  previewOpen: boolean;
  onTogglePreview: () => void;
}

function win() {
  return isTauri ? getCurrentWindow() : null;
}

/* 画多大：一个像素格 2 个屏幕点。半格正好落在整屏幕点上，所以不会糊。 */
const SCALE = 2;

/* hover 时整只眼睛（6×6 半格）换成符号：左眼 ×、右眼 +。
   4×4 里画的 × 会糊成一个菱形，六格才叉得开。 */
const CROSS = ["#....#", ".#..#.", "..##..", "..##..", ".#..#.", "#....#"];
const PLUS = ["..##..", "..##..", "######", "######", "..##..", "..##.."];

/**
 * 左上角的猫：和 app 图标同一份像素画（`kernel/nekoArt`），所以两处不可能长得不一样。
 *
 * 平时是活的（眨眼 + 眼珠跟光标，都在 `NekoFace` 里）；hover 时左眼变 ×、右眼变 +，
 * 就是 close / zoom。
 */
function NekoControls() {
  /* 命中区比画出来的眼睛大：左右各半张脸，纵向只盖眼睛那几行——
     嘴和耳朵不该点一下就关窗口。 */
  const band = { top: (EYES[0].row - 2 - NEKO_CROP) * SCALE, height: 6 * SCALE };

  return (
    <NekoFace
      scale={SCALE}
      ink="var(--ink)"
      paper="var(--chrome)"
      sclera="var(--chrome-hi)"
      hoverEyes={[CROSS, PLUS]}
    >
      {EYES.map((eye, index) => (
        <button
          key={eye.col}
          onClick={() => (index === 0 ? void win()?.close() : void win()?.toggleMaximize())}
          title={index === 0 ? "关闭" : "缩放"}
          aria-label={index === 0 ? "关闭" : "缩放"}
          className="absolute"
          style={{
            left: index * ((NEKO_SPAN * SCALE) / 2),
            top: band.top,
            width: (NEKO_SPAN * SCALE) / 2,
            height: band.height,
          }}
        />
      ))}
    </NekoFace>
  );
}

/** 通栏标题栏：经典 Mac 顶条——左上角猫头（兼窗控）+ logo，标题居中于内容区 */
export function TopBar(props: Props) {
  const toggleMaximize = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    void win()?.toggleMaximize();
  };

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={toggleMaximize}
      className="pinstripes relative flex h-8 shrink-0 select-none items-center border-b border-[var(--ink)] px-2"
    >
      {/* 左：猫头（hover 时两眼变 close/zoom）——独占左角，不混放别的控件 */}
      <div className="z-10 flex items-center">
        <NekoControls />
      </div>

      {/* 中：窗口标题（居中于内容区——标题属于会话，不属于侧栏） */}
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute inset-y-0 flex items-center justify-center text-[12px] tracking-wide text-[var(--ink)] transition-[left,right] duration-150"
        style={{ left: props.contentOffset, right: props.rightOffset }}
      >
        <span className="pinstripes inline-block px-2">Neko — {props.sessionTitle}</span>
      </div>

      {/* 右：预览面板开关（agent 标配，打开时反白） */}
      <div className="z-10 ml-auto flex items-center">
        <button
          onClick={props.onTogglePreview}
          title="预览面板"
          className={`font-mini flex h-[15px] w-[15px] items-center justify-center border border-[var(--ink)] text-[10px] leading-none shadow-[1px_1px_0_rgba(0,0,0,0.4)] active:shadow-none ${
            props.previewOpen
              ? "bg-[var(--ink)] text-[var(--chrome-hi)]"
              : "bg-[var(--chrome-hi)] text-[var(--ink-dim)] hover:text-[var(--ink)]"
          }`}
        >
          ▤
        </button>
      </div>
    </header>
  );
}
