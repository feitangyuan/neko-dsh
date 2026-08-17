/**
 * Path helpers shared by the timeline and the preview pane.
 * Protocol-agnostic: extracts file/dir anchors out of arbitrary agent text,
 * so it stays put while the transport underneath changes.
 */

import type { MessageContentChunk } from "./types";

export function chunksText(chunks: MessageContentChunk[]): string {
  return chunks
    .map((chunk) => {
      if (chunk.type === "tool_call") return `[tool: ${chunk.name}]`;
      if (chunk.type === "image") return `[图片${chunk.name ? `: ${chunk.name}` : ""}]`;
      return chunk.text;
    })
    .join("\n");
}

export function languageForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return {
    md: "markdown",
    markdown: "markdown",
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    toml: "toml",
    py: "python",
    go: "go",
    css: "css",
    html: "html",
  }[ext ?? ""];
}

const PREVIEWABLE_EXTENSIONS = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "html",
  "htm",
  "ini",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "lock",
  "md",
  "markdown",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

export function previewPathFromText(value: string): string | null {
  let path = value.trim().replace(/^file:\/\//, "");
  path = path.replace(/^[`'"([{<]+|[`'"\])}>.,;!?]+$/g, "");
  path = path.replace(/:\d+(?::\d+)?$/, "");
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  const base = path.split("/").pop() ?? path;
  const extension = base.includes(".") ? base.split(".").pop()?.toLowerCase() : undefined;
  return extension && PREVIEWABLE_EXTENSIONS.has(extension) ? path : null;
}

export function previewPathsFromText(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const candidates = text.match(/(?:~|\/|\.\.?\/)[^\s`'"<>]+/g) ?? [];
  for (const candidate of candidates) {
    const path = previewPathFromText(candidate);
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/** 从任意文本提取绝对/~/ 路径锚点，按「目录 / 可预览文件」分类。
    目录锚点用于给相对路径链接提供上下文根（同一条消息里 ~/projects/x 与 src/… 并存）。
    bash 命令里的转义空格（Application\ Support）会还原；glob 模式截到通配符前的字面前缀。 */
export function anchorPathsFromText(text: string): { dirs: string[]; files: string[] } {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const tokens = text.match(/(?<![\w.])(?:~\/|\/)(?:\\ |[^\s`'"<>|])+/g) ?? [];
  for (const raw of tokens) {
    if (raw.startsWith("//")) continue; // URL 的 scheme 分隔符，不是路径
    let p = raw.replace(/\\ /g, " ").replace(/[\]})>*.,;:!?'"`\\]+$/, "");
    const globAt = p.search(/[*?\[]/);
    if (globAt >= 0) p = p.slice(0, globAt);
    p = p.replace(/\/+$/, "");
    if (!(p.startsWith("/") || p.startsWith("~/")) || !p.split("/").pop()) continue;
    const base = p.split("/").pop() ?? "";
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    if (ext && PREVIEWABLE_EXTENSIONS.has(ext)) {
      files.add(p);
      const dir = p.slice(0, p.length - base.length - 1);
      if (dir) dirs.add(dir);
    } else {
      dirs.add(p);
    }
  }
  return { dirs: [...dirs], files: [...files] };
}
