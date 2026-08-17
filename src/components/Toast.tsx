import type { Notification } from "../kernel/types";

export function Toast({ notification }: { notification: Notification | null }) {
  if (!notification) return null;
  const mark =
    notification.kind === "success" ? "✓" : notification.kind === "error" ? "✗" : "·";
  const color =
    notification.kind === "success"
      ? "text-[var(--success)]"
      : notification.kind === "error"
        ? "text-[var(--error)]"
        : "text-[var(--accent)]";
  return (
    <div className="toast-in fixed bottom-9 left-1/2 z-[60] -translate-x-1/2">
      <div className="flex items-center gap-1.5 border border-[var(--ink)] bg-[var(--chrome-hi)] px-3 py-1 text-[12px] text-[var(--ink)] shadow-[var(--shadow-pop)]">
        <span className={color}>{mark}</span>
        {notification.text}
      </div>
    </div>
  );
}
