import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "../lib/runtime";
import type { PreviewState } from "../kernel/types";

const MIN_W = 260;
const MAX_W = 680;

/** 右侧预览面板：单行头部（× + 文件页签 + 目录）+ 左缘拖拽调宽 */
export function PreviewPane({
  state,
  width,
  onResize,
  onClose,
  onActivate,
  onCloseFile,
}: {
  state: PreviewState | null;
  width: number;
  onResize: (w: number) => void;
  onClose: () => void;
  onActivate: (path: string) => void;
  onCloseFile: (path: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const open = state !== null;
  const active = state?.files.find((f) => f.path === state.activePath) ?? state?.files[0] ?? null;
  const activeDir = active ? active.path.split("/").slice(0, -1).join("/") : "";

  /* 左缘拖拽调宽：拖的是 pane 的左边，宽度 = 窗口宽 - 光标 x */
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent) =>
      onResize(Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX)));
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <aside
      className={`relative shrink-0 overflow-hidden bg-[var(--bg-surface)] ${
        open ? "border-l border-[var(--ink)]" : ""
      } ${dragging ? "" : "transition-[width] duration-150 ease-out"}`}
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <div
          onMouseDown={startDrag}
          title="拖动调整宽度"
          className="absolute inset-y-0 left-0 z-20 w-[5px] cursor-col-resize"
        />
      )}
      <div className="flex h-full flex-col" style={{ width }}>
        {state && active && (
          <>
            {/* 单行头部：× 关面板 + 页签行（激活页签咬合并白底）+ 右侧目录 */}
            <div className="pinstripes flex h-7 shrink-0 select-none items-end gap-1 border-b border-[var(--ink)] px-1.5 pt-1">
              <div className="flex h-full items-center">
                <button
                  onClick={onClose}
                  title="关闭预览"
                  className="font-mini flex h-[13px] w-[13px] shrink-0 items-center justify-center border border-[var(--ink)] bg-[var(--chrome-hi)] text-[10px] leading-none text-[var(--ink-dim)] shadow-[1px_1px_0_rgba(0,0,0,0.4)] hover:text-[var(--ink)] active:shadow-none"
                >
                  ×
                </button>
              </div>
              <div className="flex min-w-0 flex-1 items-end gap-px overflow-x-auto">
                {state.files.map((f) => {
                  const isActive = f.path === active.path;
                  const base = f.path.split("/").pop() ?? f.path;
                  return (
                    <div
                      key={f.path}
                      className={`group flex shrink-0 items-center gap-1 border border-b-0 border-[var(--ink)] px-1.5 pt-0.5 ${
                        isActive
                          ? "-mb-px bg-[var(--bg-surface)] pb-1 text-[var(--text-main)]"
                          : "bg-[var(--chrome-lo)] pb-0.5 text-[var(--ink-dim)] hover:text-[var(--ink)]"
                      }`}
                    >
                      <button
                        onClick={() => onActivate(f.path)}
                        title={f.path}
                        className="font-mini max-w-[96px] truncate text-[10px]"
                      >
                        {base}
                      </button>
                      <button
                        onClick={() => onCloseFile(f.path)}
                        title="关闭文件"
                        className="font-mini text-[10px] leading-none opacity-0 group-hover:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
              {activeDir && (
                <div className="flex h-full items-center">
                  <span className="font-mini max-w-[110px] truncate text-[10px] text-[var(--ink-dim)]">
                    {activeDir}
                  </span>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 select-text overflow-auto p-3">
              {active.language === "markdown" ? (
                <div className="markdown-preview">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      /* 预览文档里的外链同样走系统浏览器，不让 webview 跳转 */
                      a: ({ children, href, ...props }) => (
                        <a
                          href={href}
                          {...props}
                          onClick={(e) => {
                            if (href && /^https?:\/\//i.test(href)) {
                              e.preventDefault();
                              openExternal(href);
                            }
                          }}
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {active.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="font-mono text-[12px] leading-relaxed text-[var(--text-main)]">
                  <code>{active.content}</code>
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
