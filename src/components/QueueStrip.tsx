import type { QueuedPrompt } from "../kernel/types";

/**
 * 排队中的输入。
 *
 * dsh 在两个 turn 之间才派发队列，所以提交后到执行前有一段真空期——
 * 没有这条带子，用户看到的就是「我发了但什么都没发生」。
 */
interface Props {
  items: QueuedPrompt[];
  onRemove: (itemId: string) => void;
}

export function QueueStrip({ items, onRemove }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="border-t border-[var(--ink)] bg-[var(--chrome)] px-3 py-1">
      <div className="mx-auto flex max-w-[820px] flex-col gap-0.5">
        {items.map((item) => (
          <div key={item.id} className="group flex items-baseline gap-1.5">
            <span className="shrink-0 font-mini text-[10px] tracking-wider text-[var(--ink-dim)]">
              {item.placement === "steering" ? "插话" : "排队"}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink)]">
              {item.text}
            </span>
            <button
              onClick={() => onRemove(item.id)}
              title="从队列移除"
              aria-label="从队列移除"
              className="shrink-0 px-1 font-mini text-[10px] leading-none text-[var(--ink-dim)] opacity-0 hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
