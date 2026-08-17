import type { ReactNode } from "react";

/* 面板外壳的公共件（形态沿用 pi-gui 的经典窗口）。设置和插件两个面板共用。 */

export function WindowTitle({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="pinstripes flex items-center border-b border-[var(--ink)] px-1.5 py-1">
      <button
        onClick={onClose}
        title="关闭"
        aria-label="关闭"
        className="relative h-[13px] w-[13px] shrink-0 border border-[var(--ink)] bg-[var(--chrome-hi)] text-[var(--ink-dim)] shadow-[1px_1px_0_rgba(0,0,0,0.4)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] active:shadow-none"
      >
        {/* × 用两条 1px 几何斜线：像素字体的字形重心偏移、居不中 */}
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 block h-px w-[7px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current"
        />
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 block h-px w-[7px] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current"
        />
      </button>
      <span className="flex-1 text-center text-[12px]">{title}</span>
      <span className="w-[13px] shrink-0" />
    </div>
  );
}

/**
 * Classic group box: a 1px frame with its label straddling the top border.
 *
 * The hierarchy is containment, not type size — the label stays the same 12px
 * as the rows it heads, because a heading smaller than its body reads as
 * metadata no matter how it is coloured. Mac OS 8's own control panels group
 * this way, so the frame is period-correct as well as legible.
 */
export function SettingGroup({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="px-4 pt-3 last:pb-4">
      <fieldset className="border border-[var(--border-main)] px-3 pb-1.5">
        {(title || hint) && (
          <legend className="flex items-baseline gap-2 px-1.5 text-[12px]">
            <span className="truncate">{title}</span>
            {hint && (
              <span className="font-mini shrink-0 text-[10px] text-[var(--text-muted)]">
                {hint}
              </span>
            )}
          </legend>
        )}
        {children}
      </fieldset>
    </section>
  );
}
