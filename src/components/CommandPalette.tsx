import { useEffect, useMemo, useRef, useState } from "react";
import type { Kernel } from "../kernel/types";

interface PaletteItem {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** ⌘K 面板：经典 Mac 下拉菜单形态（灰面黑边、反白选中、偏移实影） */
export function CommandPalette({
  open,
  onClose,
  kernel,
  onToggleSidebar,
  onOpenPlugins,
  onOpenScheduled,
}: {
  open: boolean;
  onClose: () => void;
  kernel: Kernel;
  onToggleSidebar: () => void;
  onOpenPlugins: () => void;
  onOpenScheduled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items: PaletteItem[] = useMemo(
    () => [
      { group: "操作", label: "新建会话", hint: "⌘N", run: kernel.newSession },
      { group: "操作", label: "压缩上下文", hint: "/compact", run: () => kernel.compact() },
      { group: "操作", label: "分叉会话", run: () => kernel.forkSession() },
      {
        group: "操作",
        label: "重命名会话",
        run: () => kernel.renameSession(kernel.sessionId),
      },
      { group: "操作", label: "导出会话", hint: "存到下载", run: kernel.exportSession },
      { group: "操作", label: "刷新会话列表", run: kernel.refreshSessions },
      /* 侧栏收起时这两个一级入口就没了，面板是它们的第二条路 */
      { group: "操作", label: "插件", run: onOpenPlugins },
      { group: "操作", label: "定时任务", run: onOpenScheduled },
      { group: "操作", label: "设置…", hint: "⌘,", run: kernel.openSettings },
      {
        /* Toggling picks an explicit side, which also leaves "system" behind —
           the same thing the settings panel writes, through the same setter. */
        group: "视图",
        label: kernel.theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
        run: () => kernel.setThemePreference(kernel.theme === "dark" ? "light" : "dark"),
      },
      { group: "视图", label: "切换侧栏", hint: "⌘B", run: onToggleSidebar },
      ...kernel.availableModels.map((m) => ({
        group: "Model",
        label: m.name,
        hint: m.id === kernel.currentModel ? "当前" : m.provider,
        run: () => kernel.setModel(m.id),
      })),
      ...kernel.availableThinkingLevels.map((l) => ({
        group: "思考深度",
        label: l.name,
        hint: l.id === kernel.thinkingLevel ? "当前" : l.description,
        run: () => kernel.setThinkingLevel(l.id),
      })),
      ...kernel.commands.map((c) => ({
        group: "命令",
        label: `/${c.name}`,
        hint: c.description,
        run: () => kernel.executeCommand(c.name),
      })),
    ],
    [kernel, onToggleSidebar, onOpenPlugins, onOpenScheduled]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const pick = (item: PaletteItem) => {
    onClose();
    // 等面板关闭后再执行，避免对话框与面板同帧竞争焦点
    requestAnimationFrame(() => item.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (i + 1) % Math.max(1, filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (i - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[index]) pick(filtered[index]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[520px] border border-[var(--ink)] bg-[var(--chrome-hi)] shadow-[var(--shadow-pop)]">
        {/* 输入行 */}
        <div className="flex items-center gap-2 border-b border-[var(--ink)] px-3 py-2">
          <span className="text-[12px] text-[var(--ink)]">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入命令或搜索…"
            className="w-full bg-transparent text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-dim)]"
          />
          <span className="border border-[var(--ink-dim)] px-1 font-mini text-[10px] text-[var(--ink-dim)]">Esc</span>
        </div>
        {/* 列表：选中反白 */}
        <div ref={listRef} className="max-h-[330px] overflow-y-auto py-0.5">
          {filtered.length === 0 && (
            <div className="px-3 py-5 text-center font-mini text-[10px] text-[var(--ink-dim)]">(没有匹配的命令)</div>
          )}
          {filtered.map((item, i) => {
            const prev = filtered[i - 1];
            const showHeader = !query && item.group !== prev?.group;
            const active = i === index;
            return (
              <div key={`${item.group}-${item.label}`}>
                {showHeader && (
                  <div className="border-b border-[var(--chrome-lo)] px-3 py-0.5 font-mini text-[10px] tracking-wider text-[var(--ink-dim)]">
                    {item.group}
                  </div>
                )}
                <button
                  data-idx={i}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => pick(item)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12px] ${
                    active ? "bg-[var(--ink)] text-[var(--chrome-hi)]" : "text-[var(--ink)]"
                  }`}
                >
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.hint && (
                    <span className={`shrink-0 font-mini text-[10px] ${active ? "text-[var(--chrome)]" : "text-[var(--ink-dim)]"}`}>
                      {item.hint}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
