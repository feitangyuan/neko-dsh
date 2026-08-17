/**
 * dsh `/api` transport and the session-event fold.
 *
 * Every call goes through the Rust side: `/api` carries a browser-trust fence
 * that rejects the webview's `tauri://localhost` origin, so the webview never
 * touches the runtime directly. Downstream is two WebSocket downlinks, relayed
 * here as `dsh:frame`.
 *
 * The fold turns dsh's append-only session log into pi-gui's message model.
 * It is incremental on purpose — a text delta must not cost a re-fold of the
 * whole log — and order-addressed rather than append-only, because history
 * pages backwards and lands events older than everything already folded.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MessageContentChunk, TimelineMessage } from "./types";

// ---- Wire shapes (only the fields this client reads) ----

export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: any;
}

export interface MuxFrame {
  type: string;
  sessionId?: string;
  event?: SessionEvent;
  [key: string]: any;
}

export interface HostFrame {
  type: string;
  sessionId?: string;
  running?: boolean;
  [key: string]: any;
}

export interface FramePayload {
  stream: "mux" | "host";
  rpcId: string;
  payload: MuxFrame | HostFrame;
}

/** `{ ok: true, value }` on success; the failure branch carries dsh's error taxonomy. */
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export class DshError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DshError";
  }
}

// ---- Transport ----

/** Boot the runtime (or adopt the running one) and open both downstream streams. */
export function startRuntime(): Promise<string> {
  return invoke<string>("dsh_start");
}

/**
 * The bundled dsh version.
 *
 * Not `host.describe().version`: that field is a hardcoded `"0.0.1"` upstream,
 * with a TODO to read the real manifest. Rust reads the package we ship.
 */
export function runtimeVersion(): Promise<string> {
  return invoke<string>("dsh_version");
}

/**
 * Profile plugins.
 *
 * dsh exposes no `/api` method for installing them — `dsh plugin` is a CLI-only
 * pnpm forwarder — so these run the bundled CLI out of process instead of going
 * through the bridge. `pluginInventory/list` (live load state) does ride `/api`.
 */
export function pluginList(): Promise<
  { name: string; version: string; description: string; active: boolean; removable: boolean }[]
> {
  return invoke("dsh_plugin_list");
}

export function pluginAdd(spec: string): Promise<string> {
  return invoke<string>("dsh_plugin_add", { spec });
}

export function pluginRemove(name: string): Promise<string> {
  return invoke<string>("dsh_plugin_remove", { name });
}

/** Reap the runtime and boot a fresh one; the profile's layers are read at boot. */
export function restartRuntime(): Promise<string> {
  return invoke<string>("dsh_restart");
}

/** One unary call. A protocol-level failure throws `DshError`; transport failures throw `Error`. */
export async function call<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
  const result = await invoke<RpcResult<T>>("dsh_call", { method, payload });
  if (!result.ok) throw new DshError(result.error.code, result.error.message);
  return result.value;
}

/** Answer an approval or question frame. The rpcId is echoed from the frame, never minted. */
export function respond(rpcId: string, result: unknown): Promise<unknown> {
  return invoke("dsh_respond", { rpcId, result });
}

/** Save the session log archive. Export is a GET, not an RPC; @returns the file written. */
export function exportSessionLog(sessionId: string): Promise<string> {
  return invoke<string>("dsh_export_session", { sessionId });
}

/**
 * The system folder panel.
 *
 * Not `host.pickDirectory`: in the web profile that method answers `null` at
 * once, because it expects a browser client to draw its own directory browser
 * on top of `host.listDirectory`. A Mac app should show Finder's panel.
 */
export function pickDirectory(): Promise<string | null> {
  return invoke<string | null>("pick_directory");
}

/** Bounce the Dock icon — see `request_attention` in main.rs. */
export function requestAttention(): Promise<void> {
  return invoke<void>("request_attention");
}

export function onFrame(handler: (frame: FramePayload) => void): Promise<UnlistenFn> {
  return listen<FramePayload>("dsh:frame", (event) => handler(event.payload));
}

export function onStream(
  handler: (state: { stream: "mux" | "host"; state: "open" | "closed" }) => void
): Promise<UnlistenFn> {
  return listen<{ stream: "mux" | "host"; state: "open" | "closed" }>("dsh:stream", (event) =>
    handler(event.payload)
  );
}

// ---- Session event fold ----

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** Assistant content blocks → render chunks. Unknown block types are dropped, not rendered raw. */
function blocksToChunks(blocks: unknown): MessageContentChunk[] {
  if (!Array.isArray(blocks)) return [];
  const chunks: MessageContentChunk[] = [];
  for (const block of blocks as any[]) {
    switch (block?.type) {
      case "text":
        chunks.push({ type: "text", text: String(block.text ?? "") });
        break;
      case "reasoning":
        chunks.push({ type: "thinking", text: String(block.text ?? "") });
        break;
      case "image":
        /* The durable block holds only a reference; the bytes come back from
           `session.attachment` when something actually renders it. */
        if (block.attachment?.attachmentId) {
          chunks.push({
            type: "image",
            attachmentId: String(block.attachment.attachmentId),
            mediaType: String(block.attachment.mediaType ?? "image/png"),
            width: Number(block.attachment.width ?? 0),
            height: Number(block.attachment.height ?? 0),
            name: block.attachment.name,
          });
        }
        break;
      case "tool-call":
        chunks.push({
          type: "tool_call",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          args: parseArguments(block.arguments),
          status: "running",
        });
        break;
      default:
        break;
    }
  }
  return chunks;
}

/** Tool arguments ride the wire as a JSON string; a partial one is still worth showing. */
function parseArguments(raw: unknown): any {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function plainText(chunks: MessageContentChunk[]): string {
  return chunks
    .filter((chunk): chunk is { type: "text"; text: string } => chunk.type === "text")
    .map((chunk) => chunk.text)
    .join("");
}

/** One folded message plus the log position that orders it. */
interface Entry {
  /** The lowest seq that contributed to this message — its place in the log. */
  order: number;
  message: TimelineMessage;
}

/**
 * Incremental fold from session events to timeline messages.
 *
 * Events are addressed by `seq`, so replaying a history page over frames already
 * received is safe: a seq seen once is ignored. Assistant output is keyed by
 * `turn:step`, which is how dsh groups a single model step's chunks, its final
 * message, and the tool calls it issued.
 *
 * Messages are held in `order` sequence rather than arrival sequence. History
 * pages backwards from the tail, so an older page delivers events that belong
 * above everything already folded; an append-only array would show them last.
 * Everything that points at a message points at its id, never its position,
 * because a prepended page shifts every position after it.
 */
export class Timeline {
  /** Sorted by `order` ascending. */
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  /** Rebuilt lazily so a render per animation frame does not cost a copy per event. */
  private cache: TimelineMessage[] | null = null;
  private seen = new Set<number>();
  /** `turn:step` → message id. */
  private steps = new Map<string, string>();
  /** `turn:step` → provider block index → position in that message's chunks. */
  private slots = new Map<string, Map<number, number>>();
  /**
   * Steps whose `assistant/message` has landed.
   *
   * That event carries the step's authoritative content, so a delta arriving
   * afterwards would append the same text a second time. Order is not
   * guaranteed: a history page can deliver a step's deltas after a live frame
   * already delivered its final message.
   */
  private sealed = new Set<string>();
  /** tool callId → the message holding its chunk, and where in that message. */
  private calls = new Map<string, { id: string; chunk: number }>();

  reset(): void {
    this.entries = [];
    this.byId.clear();
    this.cache = null;
    this.seen.clear();
    this.steps.clear();
    this.slots.clear();
    this.sealed.clear();
    this.calls.clear();
  }

  snapshot(): TimelineMessage[] {
    if (this.cache === null) this.cache = this.entries.map((entry) => entry.message);
    return this.cache;
  }

  /** The log position of a message, for anything that has to name a seq — fork, mostly. */
  seqOf(messageId: string): number | undefined {
    return this.byId.get(messageId)?.order;
  }

  /** @returns whether the event changed anything worth re-rendering. */
  apply(event: SessionEvent): boolean {
    if (this.seen.has(event.seq)) return false;
    this.seen.add(event.seq);

    switch (event.type) {
      case "user/message":
        return this.addUserMessage(event);
      case "assistant/chunk":
        return this.applyChunk(event);
      case "assistant/message":
        return this.applyAssistantMessage(event);
      case "tool/call":
        return this.applyToolCall(event);
      case "tool/result":
        return this.applyToolResult(event);
      case "compaction/start":
      case "compaction/end":
        return this.applyCompaction(event);
      default:
        /* The event vocabulary is merge-extensible, and what is left is either
           trace data (usage, retries, hooks, per-node prune pricing) or state
           the runtime already folds into a projection the kernel reads — plan
           mode, goals, todos and the permission preset all arrive that way. */
        return false;
    }
  }

  // ---- Ordered store ----

  private place(entry: Entry): void {
    /* Live frames arrive newest-last, so the common case is one comparison. */
    const last = this.entries[this.entries.length - 1];
    if (last === undefined || last.order <= entry.order) {
      this.entries.push(entry);
    } else {
      let low = 0;
      let high = this.entries.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (this.entries[middle].order <= entry.order) low = middle + 1;
        else high = middle;
      }
      this.entries.splice(low, 0, entry);
    }
    this.cache = null;
  }

  private open(id: string, order: number, message: TimelineMessage): Entry {
    const entry: Entry = { order, message };
    this.byId.set(id, entry);
    this.place(entry);
    return entry;
  }

  /** Replace a message in place. The entry object is stable; the message is not. */
  private write(entry: Entry, message: TimelineMessage): void {
    entry.message = message;
    this.cache = null;
  }

  /**
   * Pull a message earlier if an older page proves it started before we thought.
   *
   * A page boundary can split one `turn:step`: the tail page opens the message at
   * a high seq, then the previous page delivers the same step's first events.
   */
  private anchor(entry: Entry, order: number): void {
    if (order >= entry.order) return;
    this.entries.splice(this.entries.indexOf(entry), 1);
    entry.order = order;
    this.place(entry);
  }

  private stepKey(data: any): string {
    return `${data?.turn ?? 0}:${data?.step ?? 0}`;
  }

  /**
   * Locate (or open) the assistant message for an event's `turn:step`.
   *
   * Opened by the first content-bearing event, never by `step/start`: dsh emits
   * `step/start` before the `user/message` that provoked it, so anchoring there
   * would place every reply above its own prompt — and would leave an empty
   * bubble behind for a step that produced nothing.
   */
  private assistantAt(event: SessionEvent): Entry {
    const key = this.stepKey(event.data);
    const id = this.steps.get(key);
    const existing = id === undefined ? undefined : this.byId.get(id);
    if (existing) {
      this.anchor(existing, event.seq);
      return existing;
    }
    const fresh = `assistant-${key}`;
    this.steps.set(key, fresh);
    this.slots.set(key, new Map());
    return this.open(fresh, event.seq, {
      id: fresh,
      role: "assistant",
      content: "",
      chunks: [],
      timestamp: event.time,
      isStreaming: true,
    });
  }

  private addUserMessage(event: SessionEvent): boolean {
    /* Whitelist, not blocklist: dsh injects workspace instructions, the runtime
       context snapshot, the skill catalog and tool results as user-role messages
       too, each with its own `source.kind`. Only what the person typed carries
       `kind: "user"`, and only that belongs in the transcript. */
    if (event.data?.source?.kind !== "user") return false;
    const chunks = blocksToChunks(event.data?.content);
    if (chunks.length === 0) return false;
    const id = String(event.data?.id ?? `user-${event.seq}`);
    if (this.byId.has(id)) return false;
    this.open(id, event.seq, {
      id,
      role: "user",
      content: plainText(chunks),
      chunks,
      timestamp: event.time,
    });
    return true;
  }

  /**
   * Mark where the context was compacted.
   *
   * dsh brackets a compaction with `start` / `end` around a `summary` and one
   * `prune` per shadowed tool result. Only the bracket is worth a line: the
   * transcript above it stays on screen, but the model no longer sees all of
   * it, and without a marker that is invisible.
   */
  private applyCompaction(event: SessionEvent): boolean {
    const id = `compaction-${event.data?.compactionId ?? event.seq}`;
    const done = event.type === "compaction/end";
    /* Measured 2026-08-16: `error` is a bare string here, not the `{code,
       message}` envelope the rpc surfaces use. */
    const error = event.data?.error;
    const reason = typeof error === "string" ? error : error?.message;
    const content = !done
      ? "正在压缩上下文…"
      : error === undefined
        ? "上下文已压缩"
        : `上下文压缩失败：${reason ?? "未知原因"}`;

    const held = this.byId.get(id);
    if (held) {
      /* A history page can split the bracket, so `end` may be folded first —
         `start` then only contributes its position, never its wording. */
      this.anchor(held, event.seq);
      if (!done || held.message.content === content) return false;
      this.write(held, { ...held.message, content });
      return true;
    }
    this.open(id, event.seq, {
      id,
      role: "compaction",
      content,
      chunks: [],
      timestamp: event.time,
    });
    return true;
  }

  private applyChunk(event: SessionEvent): boolean {
    const chunk = event.data?.chunk;
    const kind = chunk?.type;
    const opening = kind === "block-start";
    const closing = kind === "block-end";
    const delta = kind === "text-delta" || kind === "reasoning-delta";
    if (!opening && !closing && !delta) return false;
    /* A tool call streams its arguments a fragment at a time, but a chunk only
       becomes renderable once `tool/call` names the tool — until then there is
       nothing to label the row with. */
    if (opening && chunk.blockType !== "text" && chunk.blockType !== "reasoning") return false;

    const key = this.stepKey(event.data);
    if (this.sealed.has(key)) return false;
    const entry = this.assistantAt(event);
    const slots = this.slots.get(key);
    if (!slots) return false;

    const chunks = [...entry.message.chunks];
    let position = slots.get(chunk.index);
    /* Out of range means the final message re-indexed the slots under a late
       delta; reopening is better than writing past the end of the array. */
    if (position === undefined || position >= chunks.length) {
      if (closing) return false;
      const reasoning = kind === "reasoning-delta" || chunk.blockType === "reasoning";
      position = chunks.length;
      slots.set(chunk.index, position);
      chunks.push(
        reasoning ? { type: "thinking", text: "", isStreaming: true } : { type: "text", text: "" }
      );
    } else if (opening) {
      /* The block is already open — the deltas got here first. */
      return false;
    }

    const target = chunks[position];
    if (target.type !== "text" && target.type !== "thinking") return false;
    if (closing) {
      /* The reasoning header stops spinning here rather than at the end of the
         step, which is where the model actually stopped thinking. */
      if (target.type !== "thinking" || target.isStreaming !== true) return false;
      chunks[position] = { ...target, isStreaming: false };
    } else if (delta) {
      chunks[position] = { ...target, text: target.text + String(chunk.text ?? "") };
    }
    this.write(entry, { ...entry.message, chunks, content: plainText(chunks) });
    return true;
  }

  /** The step's authoritative content. Replaces whatever the deltas accumulated. */
  private applyAssistantMessage(event: SessionEvent): boolean {
    const key = this.stepKey(event.data);
    const chunks = blocksToChunks(event.data?.message?.content);
    /* An empty assistant/message exists only to carry a max-tokens step's usage.
       It must not conjure a blank bubble for a step that never produced output. */
    if (chunks.length === 0 && !this.steps.has(key)) return false;
    const entry = this.assistantAt(event);

    /* Tool calls carry their outcome from the tool/result event, which may already
       have landed — keep the status the running message had. */
    const previous = entry.message.chunks;
    for (const chunk of chunks) {
      if (chunk.type !== "tool_call") continue;
      const earlier = previous.find(
        (candidate) => candidate.type === "tool_call" && candidate.id === chunk.id
      );
      if (earlier && earlier.type === "tool_call") {
        chunk.status = earlier.status;
        chunk.result = earlier.result;
        chunk.startTime = earlier.startTime;
        chunk.endTime = earlier.endTime;
      }
    }

    this.write(entry, {
      ...entry.message,
      chunks,
      content: plainText(chunks),
      isStreaming: false,
    });
    /* The step is settled: its deltas are spent and its slot map with them. */
    this.sealed.add(key);
    this.slots.set(key, new Map());
    chunks.forEach((chunk, position) => {
      if (chunk.type === "tool_call") {
        this.calls.set(chunk.id, { id: entry.message.id, chunk: position });
      }
    });
    return chunks.length > 0;
  }

  private applyToolCall(event: SessionEvent): boolean {
    const callId = String(event.data?.callId ?? "");
    if (!callId) return false;
    const entry = this.assistantAt(event);
    const chunks = [...entry.message.chunks];

    let position = chunks.findIndex((chunk) => chunk.type === "tool_call" && chunk.id === callId);
    if (position === -1) {
      position = chunks.length;
      chunks.push({
        type: "tool_call",
        id: callId,
        name: String(event.data?.name ?? ""),
        args: parseArguments(event.data?.arguments),
        status: "running",
      });
    }
    const chunk = chunks[position];
    if (chunk.type === "tool_call") {
      chunks[position] = { ...chunk, status: "running", startTime: event.time };
    }
    this.write(entry, { ...entry.message, chunks });
    this.calls.set(callId, { id: entry.message.id, chunk: position });
    return true;
  }

  private applyToolResult(event: SessionEvent): boolean {
    const block = event.data?.message?.content?.[0];
    const callId = String(event.data?.message?.source?.callId ?? block?.toolCallId ?? "");
    const location = this.calls.get(callId);
    if (!location) return false;
    const entry = this.byId.get(location.id);
    if (!entry) return false;

    const chunks = [...entry.message.chunks];
    const chunk = chunks[location.chunk];
    if (chunk?.type !== "tool_call") return false;

    const failed = block?.isError === true || event.data?.error !== undefined;
    chunks[location.chunk] = {
      ...chunk,
      status: failed ? "error" : "completed",
      result: blockText(block?.content),
      endTime: event.time,
    };
    this.write(entry, { ...entry.message, chunks });
    return true;
  }
}
