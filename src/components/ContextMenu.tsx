import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** 经典 Mac 右键菜单：白面黑边、反白 hover、硬阴影；贴近屏幕边缘时自动内收 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[70] min-w-[180px] border border-[var(--ink)] bg-[var(--chrome-hi)] py-0.5"
      style={{ left: pos.x, top: pos.y, boxShadow: "var(--shadow-pop)" }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
          className={`block w-full px-3 py-1 text-left text-[12px] ${
            it.danger
              ? "text-[var(--error)] hover:bg-[var(--error)] hover:text-[var(--on-accent)]"
              : "text-[var(--ink)] hover:bg-[var(--accent)] hover:text-[var(--on-accent)]"
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
