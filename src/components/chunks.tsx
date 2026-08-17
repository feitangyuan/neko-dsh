import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { previewPathFromText, previewPathsFromText } from "../kernel/paths";
import { loadPastedImage, openExternal } from "../lib/runtime";
import type { MessageContentChunk } from "../kernel/types";

/* ---------------- 文本块：Assistant 使用 GFM，用户输入保留终端样式 ---------------- */

export function TextBlock({
  text,
  streaming,
  onPreview,
  markdown = false,
}: {
  text: string;
  streaming?: boolean;
  onPreview?: (path: string) => void;
  markdown?: boolean;
}) {
  if (markdown) {
    return (
      <div className="markdown-preview markdown-message">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkPreviewPaths]}
          components={{
            a: ({ children, href, node: _node, ...props }) => {
              const path = (props as Record<string, unknown>)["data-preview-path"] as
                | string
                | undefined;
              return path && onPreview ? (
                <button
                  onClick={() => onPreview(path)}
                  title={`Preview ${path}`}
                  className="font-mono text-[var(--accent)] underline decoration-dotted hover:bg-[var(--accent-soft)]"
                >
                  {children}
                </button>
              ) : (
                <a
                  href={href}
                  {...props}
                  onClick={(e) => {
                    /* http(s) 外链 → 系统默认浏览器；锚点/相对链接保持默认行为 */
                    if (href && /^https?:\/\//i.test(href)) {
                      e.preventDefault();
                      openExternal(href);
                    }
                  }}
                >
                  {children}
                </a>
              );
            },
            code: ({ children, node: _node, ...props }) => {
              const path = (props as Record<string, unknown>)["data-preview-path"] as
                | string
                | undefined;
              return path && onPreview ? (
                <button
                  onClick={() => onPreview(path)}
                  title={`Preview ${path}`}
                  className="font-mono text-[var(--accent)] underline decoration-dotted"
                >
                  {children}
                </button>
              ) : (
                <code {...props}>{children}</code>
              );
            },
          }}
        >
          {text}
        </ReactMarkdown>
        {streaming && <span className="streaming-cursor" />}
      </div>
    );
  }

  /* 发出去的图在正文里是一行 `[image attachment {…}]`，那是给模型看的。
     人要看的是图本身，所以这里把它挑出来单独渲染。 */
  const notes = splitAttachmentNotes(text);
  if (notes.length > 1 || notes.some((part) => typeof part !== "string")) {
    return (
      <div className="text-[12px] leading-[1.75] text-[var(--text-main)]">
        {notes.map((part, i) =>
          typeof part === "string" ? (
            part === "" ? null : (
              <TextBlock key={i} text={part} onPreview={onPreview} />
            )
          ) : (
            <PastedImage key={i} note={part} />
          )
        )}
        {streaming && <span className="streaming-cursor" />}
      </div>
    );
  }

  const parts = splitCodeFences(text);
  return (
    <div className="text-[12px] leading-[1.75] text-[var(--text-main)]">
      {parts.map((p, i) =>
        p.lang !== null ? (
          <div key={i} className="my-2 border border-[var(--border-subtle)] bg-[var(--code-bg)]">
            <div className="border-b border-[var(--border-subtle)] px-2 py-0.5 font-mini text-[10px] uppercase tracking-widest text-[var(--text-dim)]">
              {p.lang || "code"}
            </div>
            <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--text-main)]">
              <code>{p.code}</code>
            </pre>
          </div>
        ) : (
          <span key={i} className="whitespace-pre-wrap break-words">
            {renderInline(p.code, onPreview)}
          </span>
        )
      )}
      {streaming && <span className="streaming-cursor" />}
    </div>
  );
}

/** 一行 `[image attachment {…}]` 里那个 JSON。宽高可能缺，其余都在。 */
type AttachmentNote = {
  attachmentId: string;
  name?: string;
  width?: number;
  height?: number;
};

/**
 * 把正文按 `[image attachment {…}]` 切开。
 *
 * 不用正则贪婪匹配到 `]`：文件名里就可能有中括号。从 `{` 开始数花括号配对，
 * 数平了再要求紧跟一个 `]`，配不上就当普通文本放过去。
 */
function splitAttachmentNotes(text: string): (string | AttachmentNote)[] {
  const MARK = "[image attachment ";
  const parts: (string | AttachmentNote)[] = [];
  let rest = text;
  for (;;) {
    const at = rest.indexOf(MARK);
    if (at === -1) break;
    const open = at + MARK.length;
    let depth = 0;
    let close = -1;
    for (let i = open; i < rest.length; i += 1) {
      if (rest[i] === "{") depth += 1;
      else if (rest[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1 || rest[close + 1] !== "]") break;
    let note: AttachmentNote | null = null;
    try {
      const parsed = JSON.parse(rest.slice(open, close + 1)) as AttachmentNote;
      if (typeof parsed.attachmentId === "string") note = parsed;
    } catch {
      note = null;
    }
    if (!note) break;
    parts.push(rest.slice(0, at).replace(/\n+$/, ""));
    parts.push(note);
    rest = rest.slice(close + 2).replace(/^\n+/, "");
  }
  parts.push(rest);
  return parts;
}

/**
 * 自己发出去的那张图。
 *
 * 字节存在会话之外（DeepSeek 不收图），要单独取一次；取不到就退回文件名和尺寸，
 * 至少能看出当时发的是哪张——运行时重启后就是这个样子。
 */
function PastedImage({ note }: { note: AttachmentNote }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dropped = false;
    loadPastedImage(note.attachmentId)
      .then((url) => {
        if (!dropped) setSrc(url);
      })
      .catch(() => {
        if (!dropped) setFailed(true);
      });
    return () => {
      dropped = true;
    };
  }, [note.attachmentId]);

  const ratio =
    note.width && note.height && note.width > 0 ? note.height / note.width : 0.75;
  return (
    <div className="my-1 inline-block max-w-[320px] border border-[var(--border-main)] bg-[var(--bg-surface)] p-0.5">
      {src ? (
        <img src={src} alt={note.name ?? "图片"} className="block max-w-full" />
      ) : (
        <div
          className="flex items-center justify-center font-mini text-[10px] text-[var(--text-dim)]"
          style={{ width: 200, height: Math.min(240, Math.round(200 * ratio)) }}
        >
          {failed ? (note.name ?? "图片") : "读取中…"}
        </div>
      )}
    </div>
  );
}

function remarkPreviewPaths() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!Array.isArray(node.children)) return;
      const next: any[] = [];
      for (const child of node.children) {
        if (child.type === "inlineCode") {
          const path = previewPathFromText(String(child.value ?? ""));
          if (path) {
            child.data = {
              ...child.data,
              hProperties: { ...child.data?.hProperties, "data-preview-path": path },
            };
          }
          next.push(child);
        } else if (child.type === "text" && node.type !== "link") {
          next.push(...previewTextNodes(String(child.value ?? "")));
        } else {
          walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}

function previewTextNodes(value: string): any[] {
  const paths = previewPathsFromText(value);
  if (!paths.length) return [{ type: "text", value }];
  const nodes: any[] = [];
  let offset = 0;
  for (const path of paths) {
    const index = value.indexOf(path, offset);
    if (index < 0) continue;
    if (index > offset) nodes.push({ type: "text", value: value.slice(offset, index) });
    nodes.push({
      type: "link",
      url: "#",
      children: [{ type: "text", value: path }],
      data: { hProperties: { "data-preview-path": path } },
    });
    offset = index + path.length;
  }
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

interface CodePart {
  lang: string | null;
  code: string;
}

function splitCodeFences(text: string): CodePart[] {
  const out: CodePart[] = [];
  const re = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ lang: null, code: text.slice(last, m.index) });
    out.push({ lang: m[1] || "", code: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ lang: null, code: text.slice(last) });
  return out;
}

/** 行内 `code` 与 **粗体** */
function renderInline(text: string, onPreview?: (path: string) => void): React.ReactNode[] {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(...renderPlainPaths(text.slice(last, m.index), onPreview, key++));
    const tok = m[0];
    if (tok.startsWith("`")) {
      const value = tok.slice(1, -1);
      const path = onPreview ? previewPathFromText(value) : null;
      nodes.push(
        path ? (
          <button
            key={key++}
            onClick={() => onPreview?.(path)}
            title={`Preview ${path}`}
            className="border border-[var(--border-main)] bg-[var(--bg-elevated)] px-1 py-px font-mono text-[12px] text-[var(--accent)] underline decoration-dotted hover:bg-[var(--accent-soft)]"
          >
            {value}
          </button>
        ) : (
          <code
            key={key++}
            className="border border-[var(--border-main)] bg-[var(--bg-elevated)] px-1 py-px font-mono text-[12px] text-[var(--accent)]"
          >
            {value}
          </code>
        ),
      );
    } else {
      nodes.push(
        <strong key={key++} className="bg-[var(--accent-soft)] px-0.5 text-[var(--text-main)]">
          {renderInline(tok.slice(2, -2), onPreview)}
        </strong>
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(...renderPlainPaths(text.slice(last), onPreview, key++));
  return nodes;
}

function renderPlainPaths(
  text: string,
  onPreview: ((path: string) => void) | undefined,
  keySeed: number,
): React.ReactNode[] {
  if (!onPreview) return [text];
  const paths = previewPathsFromText(text);
  if (!paths.length) return [text];
  const nodes: React.ReactNode[] = [];
  let rest = text;
  paths.forEach((path, index) => {
    const offset = rest.indexOf(path);
    if (offset < 0) return;
    if (offset > 0) nodes.push(rest.slice(0, offset));
    nodes.push(
      <button
        key={`path-${keySeed}-${index}`}
        onClick={() => onPreview(path)}
        title={`Preview ${path}`}
        className="font-mono text-[var(--accent)] underline decoration-dotted hover:bg-[var(--accent-soft)]"
      >
        {path}
      </button>,
    );
    rest = rest.slice(offset + path.length);
  });
  if (rest) nodes.push(rest);
  return nodes;
}

/* ---------------- 折叠容器：经典 Mac ▸ 三角 ---------------- */

function Collapsible({
  header,
  children,
  defaultOpen = false,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div className="flex w-full items-baseline gap-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        >
          <span
            className={`inline-block font-mini text-[10px] text-[var(--text-dim)] transition-transform duration-150 ${
              open ? "rotate-90" : ""
            }`}
          >
            ▸
          </span>
          {header}
        </button>
      </div>
      <div className={`collapse-grid ${open ? "open" : ""}`}>
        <div>
          <div className="pt-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- thinking 块：默认折叠 ---------------- */

function ThinkingChunk({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Collapsible
      header={
        <span className="text-[12px] text-[var(--text-dim)]">
          {streaming ? (
            <>
              <span className="spin mr-1 text-[var(--accent)]">◐</span>思考中…
            </>
          ) : (
            "思考过程"
          )}
        </span>
      }
    >
      <div className="ml-[5px] border-l border-[var(--border-main)] pl-2.5">
        <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-muted)]">
          {text}
          {streaming && <span className="streaming-cursor" />}
        </p>
      </div>
    </Collapsible>
  );
}

/* ---------------- 工具调用块：默认折叠 ---------------- */

function ToolCallChunk({
  chunk,
}: {
  chunk: Extract<MessageContentChunk, { type: "tool_call" }>;
}) {
  const duration =
    chunk.startTime && chunk.endTime ? `${((chunk.endTime - chunk.startTime) / 1000).toFixed(1)}s` : null;

  return (
    <Collapsible
      header={
        <span className="min-w-0 text-[12px]">
          <span className="text-[var(--accent)]">{chunk.name}</span>
          <span className="text-[var(--text-dim)]"> {formatArgsInline(chunk.args)}</span>
          {chunk.status === "running" && (
            <span className="pulse-dot ml-1.5 text-[var(--accent)]">■</span>
          )}
          {chunk.status === "completed" && (
            <span className="ml-1.5 text-[var(--success)]">✓</span>
          )}
          {chunk.status === "error" && <span className="ml-1.5 text-[var(--error)]">✗</span>}
          {duration && <span className="ml-1.5 tabular-nums text-[var(--text-dim)]">{duration}</span>}
        </span>
      }
    >
      <div className="ml-[5px] space-y-1.5 border-l border-[var(--border-main)] pl-2.5">
        <pre className="overflow-x-auto border border-[var(--border-subtle)] bg-[var(--code-bg)] px-2 py-1.5 font-mono text-[12px] leading-relaxed text-[var(--text-muted)]">
          {formatArgs(chunk.args)}
        </pre>
        {chunk.result !== undefined && (
          <pre
            className={`overflow-x-auto border px-2 py-1.5 font-mono text-[12px] leading-relaxed ${
              chunk.status === "error"
                ? "border-[var(--error)]/50 text-[var(--error)]"
                : "border-[var(--border-subtle)] text-[var(--text-muted)]"
            } bg-[var(--code-bg)]`}
          >
            {typeof chunk.result === "string" ? chunk.result : JSON.stringify(chunk.result, null, 2)}
          </pre>
        )}
      </div>
    </Collapsible>
  );
}

function formatArgs(args: any): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 1 && typeof entries[0][1] === "string") {
    return entries[0][1] as string;
  }
  return JSON.stringify(args, null, 2);
}

function formatArgsInline(args: any): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 1 && typeof entries[0][1] === "string") {
    const v = entries[0][1] as string;
    return v.length > 48 ? v.slice(0, 48) + "…" : v;
  }
  return "";
}

/* ---------------- 分发 ---------------- */

/**
 * 图片附件：日志里只有引用，字节要单独取一次。
 *
 * 先按运行时给的原始宽高占位，避免图片到位时整条时间线跳一下。
 */
function ImageChunk({
  chunk,
  onAttachment,
}: {
  chunk: Extract<MessageContentChunk, { type: "image" }>;
  onAttachment?: (attachmentId: string) => Promise<string>;
}) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!onAttachment) return;
    let dropped = false;
    onAttachment(chunk.attachmentId)
      .then((url) => {
        if (!dropped) setSrc(url);
      })
      .catch(() => {
        if (!dropped) setFailed(true);
      });
    return () => {
      dropped = true;
    };
  }, [chunk.attachmentId, onAttachment]);

  const ratio = chunk.width > 0 && chunk.height > 0 ? chunk.height / chunk.width : 0.75;
  return (
    <div className="my-1 inline-block max-w-[320px] border border-[var(--border-main)] bg-[var(--bg-surface)] p-0.5">
      {src ? (
        <img src={src} alt={chunk.name ?? "图片"} className="block max-w-full" />
      ) : (
        <div
          className="flex items-center justify-center font-mini text-[10px] text-[var(--text-dim)]"
          style={{ width: 200, height: Math.min(240, Math.round(200 * ratio)) }}
        >
          {failed ? "图片读不出来" : onAttachment ? "读取中…" : "图片"}
        </div>
      )}
      {chunk.name && (
        <div className="truncate px-1 pt-0.5 font-mini text-[10px] text-[var(--text-dim)]">{chunk.name}</div>
      )}
    </div>
  );
}

export function ChunkView({
  chunk,
  isLast,
  messageStreaming,
  onPreview,
  onAttachment,
  markdown = false,
}: {
  chunk: MessageContentChunk;
  isLast: boolean;
  messageStreaming?: boolean;
  onPreview?: (path: string) => void;
  onAttachment?: (attachmentId: string) => Promise<string>;
  markdown?: boolean;
}) {
  switch (chunk.type) {
    case "text":
      return (
        <TextBlock
          text={chunk.text}
          streaming={messageStreaming && isLast}
          onPreview={onPreview}
          markdown={markdown}
        />
      );
    case "thinking":
      return <ThinkingChunk text={chunk.text} streaming={chunk.isStreaming} />;
    case "image":
      return <ImageChunk chunk={chunk} onAttachment={onAttachment} />;
    case "tool_call":
      return <ToolCallChunk chunk={chunk} />;
  }
}
