import { useEffect, useRef, useState } from "react";

/**
 * 经典 Mac 弹出菜单：白面、黑边、反白选中、偏移实影。
 * up = 向上弹出（用于 composer 控制条 / 侧栏左下设置）；
 * plain = 无边框文字触发器（默认是凸起的经典 popup 盒子）。
 */
export interface PopupItem {
  value: string;
  label: string;
  description?: string;
}

/** One labelled run of items. Sections let a single trigger own several axes. */
export interface PopupSection {
  title?: string;
  items: PopupItem[];
  activeValue?: string;
  onSelect: (v: string) => void;
}

export function PopupMenu({
  trigger,
  items,
  sections,
  activeValue,
  onSelect,
  width = 220,
  up = false,
  plain = false,
  compact = false,
  chevron = true,
}: {
  trigger: React.ReactNode;
  items?: PopupItem[];
  sections?: PopupSection[];
  activeValue?: string;
  onSelect?: (v: string) => void;
  width?: number;
  up?: boolean;
  plain?: boolean;
  compact?: boolean;
  chevron?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /* One code path below: a flat `items` list is just an unnamed single section. */
  const resolved: PopupSection[] =
    sections ?? [{ items: items ?? [], activeValue, onSelect: onSelect ?? (() => {}) }];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          plain
            ? `px-1.5 py-0.5 text-[12px] leading-none text-[var(--ink)] transition-colors ${
                open ? "bg-[var(--ink)] text-[var(--chrome-hi)]" : "hover:bg-[var(--chrome-lo)]"
              }`
            : `flex items-center gap-1 whitespace-nowrap border border-[var(--ink)] px-1.5 text-[var(--ink)] shadow-[1px_1px_0_rgba(0,0,0,0.4)] active:shadow-none ${
                /* compact 是输入框下沿那条紧凑工具条的规格（20px 高、微标签字号），
                   整条内部自洽。表单里不要用它——那里要和按钮、输入框齐平。 */
                compact
                  ? "h-5 font-mini text-[10px] leading-none"
                  : "h-[var(--ui-control-height)] text-[12px] leading-none"
              } ${
                open ? "bg-[var(--chrome)]" : "bg-[var(--chrome-hi)]"
              }`
        }
      >
        {trigger}
        {chevron ? " ▾" : null}
      </button>
      {open && (
        <div
          className={`absolute z-40 border border-[var(--ink)] bg-[var(--chrome-hi)] py-0.5 ${
            up ? "bottom-full left-0 mb-[3px]" : "right-0 top-full mt-[3px]"
          }`}
          style={{ width, boxShadow: "var(--shadow-pop)" }}
        >
          {resolved.map((section, index) => (
            <div key={section.title ?? index}>
              {index > 0 && <div className="my-0.5 border-t border-[var(--ink)]/25" />}
              {section.title && (
                <div className="font-mini px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-[var(--ink-dim)]">
                  {section.title}
                </div>
              )}
              {section.items.map((it) => {
                const active = it.value === section.activeValue;
                return (
                  <button
                    key={it.value}
                    onClick={() => {
                      section.onSelect(it.value);
                      setOpen(false);
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-1 text-left ${
                      active
                        ? "bg-[var(--accent)] text-[var(--on-accent)]"
                        : "text-[var(--ink)] hover:bg-[var(--accent)] hover:text-[var(--on-accent)]"
                    }`}
                  >
                    <span className="w-3 shrink-0 text-[12px] leading-[16px]">
                      {active ? "✓" : ""}
                    </span>
                    {/* The name owns the row; a description never squeezes it out. */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] leading-[16px]">{it.label}</span>
                      {it.description && (
                        <span
                          className={`font-mini block truncate text-[10px] leading-[14px] ${
                            active ? "text-[var(--chrome)]" : "text-[var(--ink-dim)]"
                          }`}
                        >
                          {it.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
