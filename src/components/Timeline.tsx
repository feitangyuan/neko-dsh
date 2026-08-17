import { useEffect, useRef } from "react";
import type { TimelineMessage } from "../kernel/types";
import { MessageItem } from "./MessageItem";
import { NekoFace } from "./NekoFace";

interface Props {
  messages: TimelineMessage[];
  isStreaming: boolean;
  sessionId: string;
  hasMoreHistory: boolean;
  isLoadingHistory: boolean;
  onLoadMore: () => void;
  onFork: (entryId: string) => void;
  onPreview: (path: string, anchorDirs?: string[]) => void;
  onAttachment: (attachmentId: string) => Promise<string>;
}

export function Timeline({
  messages,
  isStreaming,
  sessionId,
  hasMoreHistory,
  isLoadingHistory,
  onLoadMore,
  onFork,
  onPreview,
  onAttachment,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  /** 程序性滚动会触发 scroll 事件，用它消费掉，避免误判为用户上翻 */
  const suppressScroll = useRef(false);
  /** 翻页前到底部的距离：更早的消息插在上面，靠它把视口钉回原处 */
  const anchorFromBottom = useRef<number | null>(null);

  /* 用户上翻则解除吸底；回到底部恢复 */
  const onScroll = () => {
    if (suppressScroll.current) {
      suppressScroll.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const loadMore = () => {
    const el = scrollRef.current;
    if (el) anchorFromBottom.current = el.scrollHeight - el.scrollTop;
    onLoadMore();
  };

  /* 流式内容更新时，若吸底则跟随；刚翻完页则优先还原视口 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = anchorFromBottom.current;
    if (anchor !== null) {
      anchorFromBottom.current = null;
      suppressScroll.current = true;
      el.scrollTop = el.scrollHeight - anchor;
      return;
    }
    if (pinnedToBottom.current) {
      suppressScroll.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isStreaming]);

  /* 切换会话：定位到最新消息 */
  useEffect(() => {
    const el = scrollRef.current;
    pinnedToBottom.current = true;
    if (el) {
      suppressScroll.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [sessionId]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-surface)]"
      >
        <div className="mx-auto max-w-[820px] px-5 pb-5 pt-4">
          {hasMoreHistory && (
            <div className="mb-4 flex justify-center">
              <button
                onClick={loadMore}
                disabled={isLoadingHistory}
                className="border border-[var(--ink)] bg-[var(--chrome)] px-2 py-0.5 font-mini text-[10px] text-[var(--ink)] shadow-[1px_1px_0_rgba(0,0,0,0.35)] hover:bg-[var(--chrome-lo)] disabled:text-[var(--ink-dim)] disabled:shadow-none"
              >
                {isLoadingHistory ? "载入中…" : "载入更早的消息"}
              </button>
            </div>
          )}
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-4">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  onFork={onFork}
                  onPreview={onPreview}
                  onAttachment={onAttachment}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {/* 步进淡出层：浮在滚动区底缘，不随内容滚动，不挡点击与选字 */}
      <div aria-hidden="true" className="timeline-fade pointer-events-none absolute inset-x-0 bottom-0 z-10" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center text-center">
      {/* 空会话中间摆的是猫本人，不是「DSH」三个字母：这儿是产品的脸，
          不该写运行时的名字。和标题栏、app 图标同一份像素画，一样会眨眼、
          眼珠一样跟着光标走。 */}
      <NekoFace scale={5} ink="var(--text-main)" paper="var(--bg-surface)" />
      <p className="mt-3 whitespace-nowrap font-mini text-[10px] text-[var(--text-dim)]">
        说点什么 · <kbd>⌘K</kbd> 命令面板 · <kbd>/</kbd> 命令
      </p>
    </div>
  );
}
