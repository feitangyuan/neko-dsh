import { useMemo } from "react";
import { anchorPathsFromText } from "../kernel/paths";
import type { TimelineMessage } from "../kernel/types";
import { ChunkView } from "./chunks";

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function MessageItem({
  message,
  onFork,
  onPreview,
  onAttachment,
}: {
  message: TimelineMessage;
  onFork: (entryId: string) => void;
  onPreview?: (path: string, anchorDirs?: string[]) => void;
  onAttachment?: (attachmentId: string) => Promise<string>;
}) {
  /* 本消息里的目录锚点（如 ~/projects/dsh-gui），供消息内相对路径链接解析 */
  const anchorDirs = useMemo(() => anchorPathsFromText(message.content).dirs, [message.content]);
  const handlePreview = onPreview ? (p: string) => onPreview(p, anchorDirs) : undefined;
  /* compaction：虚线分隔，弱化 */
  if (message.role === "compaction") {
    return (
      <div className="flex items-center gap-2 py-0.5 text-[var(--text-dim)]">
        <span className="flex-1 border-t border-dashed border-[var(--border-main)]" />
        <span className="font-mini text-[10px] tracking-wide">── {message.content} ──</span>
        <span className="flex-1 border-t border-dashed border-[var(--border-main)]" />
      </div>
    );
  }

  /* system：更弱的一行 */
  if (message.role === "system") {
    return <div className="py-0.5 text-center font-mini text-[10px] text-[var(--text-dim)]">{message.content}</div>;
  }

  /* user：❯ 提示符 + 黑边输入行，像终端里敲下的命令 */
  if (message.role === "user") {
    return (
      <div className="group relative">
        <div className="flex border border-[var(--border-main)] bg-[var(--bg-surface)] px-2.5 py-2">
          <span className="shrink-0 select-none pr-1.5 text-[12px] text-[var(--accent)]">❯</span>
          <div className="min-w-0 flex-1">
            {message.chunks.map((c, i) => (
              <ChunkView
                key={i}
                chunk={c}
                isLast={i === message.chunks.length - 1}
                messageStreaming={message.isStreaming}
                onPreview={handlePreview}
                onAttachment={onAttachment}
              />
            ))}
          </div>
        </div>
        {/* fork/时间：绝对定位悬浮在消息框下沿，不占文档流高度，避免撑大行距。
            pointer-events 只留给可见按钮，隐藏时不挡下方内容 */}
        <div className="pointer-events-none absolute inset-x-0 top-full flex items-center justify-end gap-2 pr-0.5">
          <button
            onClick={() => onFork(message.id)}
            title="从这里分叉出新会话"
            className="pointer-events-auto font-mini text-[10px] text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--accent)] group-hover:opacity-100"
          >
            ⑂ 分叉
          </button>
          <span className="pointer-events-auto font-mini text-[10px] tabular-nums text-[var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100">
            {formatTime(message.timestamp)}
          </span>
        </div>
      </div>
    );
  }

  /* assistant：无容器，内容直接落在黑屏上。
     时间戳行只挂在真正输出文本的结果消息下；纯 thinking/tool_call 的过程消息
     不渲染这一行——否则 opacity-0 的行依然占位，工具行之间会凭空多出一截间距。 */
  const hasTextOutput = message.chunks.some((c) => c.type === "text" && c.text.trim() !== "");
  return (
    <div className="group relative">
      <div className="space-y-1.5">
        {message.chunks.map((c, i) => (
          <ChunkView
            key={i}
            chunk={c}
            isLast={i === message.chunks.length - 1}
            messageStreaming={message.isStreaming}
            onPreview={handlePreview}
            onAttachment={onAttachment}
            markdown
          />
        ))}
        {message.isStreaming && message.chunks.length === 0 && <span className="streaming-cursor" />}
      </div>
      {!message.isStreaming && hasTextOutput && (
        <div className="mt-0.5 pl-0.5">
          <span className="font-mini text-[10px] tabular-nums text-[var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100">
            {formatTime(message.timestamp)}
          </span>
        </div>
      )}
    </div>
  );
}
