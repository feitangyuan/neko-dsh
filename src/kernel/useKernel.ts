import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  call,
  DshError,
  exportSessionLog,
  onFrame,
  onStream,
  pickDirectory,
  pluginAdd,
  pluginList,
  pluginRemove,
  requestAttention,
  respond,
  restartRuntime as restartRuntimeProcess,
  runtimeVersion,
  startRuntime,
  Timeline,
  type FramePayload,
  type SessionEvent,
} from "./dshProtocol";
import {
  applyFontSize,
  DEFAULT_FONT_SIZE,
  readFontSize,
  readNotifyOnIdle,
  readStartDir,
  writeFontSize,
  writeNotifyOnIdle,
  writeStartDir,
} from "./shellPrefs";
import { languageForPath, previewPathFromText, previewPathsFromText } from "./paths";
import { applyThemePreference, asPreference } from "./theme";
import { bandAt } from "./pricing";
import { attachImage, readPreviewFile } from "../lib/runtime";
import type {
  AgentPreset,
  CommandInfo,
  ConnectionState,
  ContextUsage,
  DialogResult,
  GoalState,
  JobEntry,
  Kernel,
  ModelInfo,
  ImageLimits,
  Notification,
  PermissionState,
  PlanState,
  PromptImage,
  PluginEntry,
  PreviewFile,
  PreviewState,
  QueuedPrompt,
  SessionMeta,
  SessionSearchHit,
  SettingsNamespaceView,
  SettingsPathOp,
  SettingsSnapshot,
  SkillInfo,
  StreamingBehavior,
  SubagentEntry,
  ThemePreference,
  ThinkingLevel,
  ThinkingOption,
  TimelineMessage,
  TodoItem,
  UIDialogRequest,
  UsageDay,
  UsageHistory,
  UsageTokens,
} from "./types";

/** Live plugin load state — a typert remote endpoint, like `commands/list`. */
const PLUGIN_INVENTORY = "pluginInventory/list";

/** The settings address the shell paints from. */
const THEME_NS = "ui-theme";
const THEME_KEY = "preference";

/**
 * The dsh-backed kernel.
 *
 * Shape is pi-gui's, so nothing above this file knows about the transport.
 */

/** Long enough that typing a word is one query, short enough to feel live. */
const SEARCH_DEBOUNCE = 220;

interface TokenUsageProjection {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface ContextPressureProjection {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
}

interface ContextBreakdownProjection {
  systemTokens?: number;
  toolsTokens?: number;
  messageTokens?: number;
}

interface SessionStatsProjection {
  turns?: number;
  steps?: number;
  ttftMs?: number;
  ttftSteps?: number;
  decodeMs?: number;
  decodeTokens?: number;
}

/** The four projection units the meter reads; everything else is ignored. */
type ProjectionValues = Record<string, unknown>;

/**
 * Fold the projection store into the meter's shape.
 *
 * Every figure is host-computed: `token-meter` already anchors occupancy to
 * provider-reported usage, and re-deriving it here would drift. Note the
 * breakdown is heuristic and deliberately does NOT sum to `tokens`.
 */
function readContextUsage(values: ProjectionValues): ContextUsage {
  const usage = (values.tokenUsage ?? {}) as TokenUsageProjection;
  const pressure = (values.contextPressure ?? {}) as ContextPressureProjection;
  const breakdown = (values.contextBreakdown ?? {}) as ContextBreakdownProjection;
  const stats = (values.sessionStats ?? {}) as SessionStatsProjection;

  const tokens = pressure.projectedTokens ?? pressure.pressureTokens ?? 0;
  const contextWindow = pressure.contextWindow ?? 0;
  const ttftSteps = stats.ttftSteps ?? 0;
  const decodeMs = stats.decodeMs ?? 0;

  return {
    tokens,
    contextWindow,
    percent: contextWindow > 0 ? Math.min(100, (tokens / contextWindow) * 100) : 0,
    inputTokens: usage.uncachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    systemTokens: breakdown.systemTokens ?? 0,
    toolsTokens: breakdown.toolsTokens ?? 0,
    messageTokens: breakdown.messageTokens ?? 0,
    turns: stats.turns ?? 0,
    steps: stats.steps ?? 0,
    ttftMs: ttftSteps > 0 ? (stats.ttftMs ?? 0) / ttftSteps : 0,
    tokensPerSecond: decodeMs > 0 ? ((stats.decodeTokens ?? 0) / decodeMs) * 1000 : 0,
  };
}

/**
 * Fold the projection store into the four session states the strip paints.
 *
 * Same road as the token meter: the history tail page carries a baseline and
 * `session/projection` frames take it from there. Nothing here folds events —
 * the runtime already did, and re-deriving it client-side would drift.
 */

interface GoalProjection {
  goal?: {
    id?: string;
    revision?: number;
    objective?: string;
    phase?: GoalState["phase"];
    maxGoalRounds?: number;
    blockedReason?: { message?: string };
  };
  roundsStarted?: number;
}

function readPlan(values: ProjectionValues): PlanState {
  const plan = (values.plan ?? {}) as { active?: boolean; pending?: boolean };
  return { active: plan.active === true, pending: plan.pending === true };
}

/** `null` is the pre-create and cleared state alike — the runtime keeps them undistinguished. */
function readGoal(values: ProjectionValues): GoalState | null {
  const held = (values.goal ?? null) as GoalProjection | null;
  const goal = held?.goal;
  if (!goal?.id || !goal.objective) return null;
  return {
    id: goal.id,
    revision: goal.revision ?? 1,
    objective: goal.objective,
    phase: goal.phase ?? "active",
    blockedReason: goal.blockedReason?.message,
    maxGoalRounds: goal.maxGoalRounds ?? 0,
    roundsStarted: held?.roundsStarted ?? 0,
  };
}

/** The model's own checklist. Reset to `null` at every `turn/start`. */
function readTodos(values: ProjectionValues): TodoItem[] {
  const held = values.todos;
  if (!Array.isArray(held)) return [];
  return held
    .filter((item: any) => typeof item?.content === "string")
    .map((item: any) => ({ content: item.content, status: item.status ?? "pending" }));
}

/** `null` until the runtime reports them; the composer then refuses oversize pastes itself. */
function readImageLimits(values: ProjectionValues): ImageLimits | null {
  const held = values.imageLimits as ImageLimits | null | undefined;
  return held?.maxImageBytes ? held : null;
}

/**
 * dsh's own `displayPermissionPreset`, copied verbatim: `danger-full-access`
 * carries the product label "Full access", anything else is its kebab-case key
 * in title case. dsh's Chinese UI shows exactly these — it translates the copy
 * AROUND a preset and never the preset's name — so this shell does the same
 * and invents no names of its own.
 */
function displayPermissionPreset(value: string, name: string): string {
  if (value === "danger-full-access") return "Full access";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name;
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function readPermission(values: ProjectionValues): PermissionState {
  const held = (values.permissions ?? {}) as {
    currentValue?: string;
    options?: { value?: string; name?: string }[];
  };
  const current = held.currentValue ?? "";
  const options = (held.options ?? [])
    .filter((option) => typeof option.value === "string")
    .map((option) => {
      const value = option.value as string;
      return { value, name: displayPermissionPreset(value, option.name ?? value) };
    });
  return {
    current,
    /* `custom` is derived, so it is absent from the list until it IS current. */
    currentName:
      options.find((option) => option.value === current)?.name ??
      (current === "" ? "—" : displayPermissionPreset(current, current)),
    options,
  };
}

/**
 * dsh answers a slash command with an English receipt, and we toast it verbatim.
 * The ones our own controls raise (the 计划 chip, the permission popup, 压缩上下文)
 * are the ones a user actually sees, so they get Chinese; anything typed by hand
 * still passes through untouched rather than being dropped.
 */
const RECEIPTS: Record<string, string> = {
  "Plan mode on. Use /plan off to leave.": "计划模式开了",
  "Entering plan mode (applies from the next step). Use /plan off to leave.":
    "这一轮跑完进计划模式",
  "Plan mode off.": "计划模式关了",
  "Leaving plan mode (applies from the next step).": "这一轮跑完退出计划模式",
  "Plan mode entry cancelled.": "没进计划模式",
  "Plan mode is already inactive.": "本来就没开计划模式",
  "No compactable history yet.": "还没有可压缩的历史",
  "Compaction cancelled.": "压缩取消了",
  "Compaction is unavailable because this process has an active compaction, or the agent is not idle.":
    "有一个压缩正在跑，或者会话还没停下来",
  "The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.":
    "压缩期间历史变了，对话没动",
  "Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.":
    "模型没写出摘要，压缩没做成，对话没动",
  "Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.":
    "压缩没干净收尾，历史可能已经变了，先看看再重试",
  "Compaction finished, but the session could not be saved.": "压缩做完了，但会话没存下来",
};

function translateReceipt(text: string | undefined): string | undefined {
  if (!text) return text;
  const known = RECEIPTS[text];
  if (known) return known;
  /* `/permission <name>` answers a bare `preset <name>` — say what happened. */
  const preset = /^preset (.+)$/.exec(text);
  if (preset) return `权限档：${displayPermissionPreset(preset[1], preset[1])}`;
  const compacted = /^Compacted (\d+) history items \(~(\d+) tokens\)\.$/.exec(text);
  if (compacted) return `压缩了 ${compacted[1]} 条历史，约 ${compacted[2]} token`;
  return text;
}

interface HostDescription {
  version: string;
  cwd: string;
  provider?: string;
  model?: string;
}

/** dsh names credentials after the environment variable an adapter would read. */
const DEEPSEEK_KEY_REF = "DEEPSEEK_API_KEY";

/* Where `agent-presets` keeps the id a session is composed from when nobody names one. */
const AGENT_PRESET_NS = "agent-presets";
const AGENT_PRESET_DEFAULT_KEY = "default";
/* What a fresh Agent is routed to when no session says otherwise. */
const AGENT_MODEL_NS = "agent-default-model";
const PERMISSION_NS = "permission";
const PERMISSION_DEFAULT_KEY = "defaultPreset";

interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  /* Set only on subagent children — the sidebar filters on it. */
  origin?: "subagent";
  parentSessionId?: string;
  cwd?: string;
  agentPreset?: string;
  projections?: { values?: Record<string, unknown> };
}

interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
}

interface HistoryPage {
  events: { event: SessionEvent }[];
  hasMore: boolean;
  projections?: { asOfSeq?: number; values?: ProjectionValues };
}

/** `session.models`: adapter-owned catalogue plus the session's current route. */
interface ModelsView {
  current?: { provider: string; model: string; reasoningEffort?: string };
  routable: boolean;
  groups: {
    id: string;
    name: string;
    models: {
      id: string;
      name: string;
      description?: string;
      reasoning?: { efforts: ThinkingOption[]; defaultEffort?: string };
    }[];
  }[];
}

/**
 * Slash commands ride the typert remote interceptor, not `RpcMethodMap` — same
 * `/api` channel, so the existing proxy reaches it with no extra plumbing.
 */
const COMMANDS_METHOD = "commands/list";
const COMMANDS_EXECUTE = "commands/execute";

interface PendingDialog {
  request: UIDialogRequest;
  resolve: (result: DialogResult) => void;
}

/** dsh has no title column: it rides a projection, and a fresh session has none yet. */
function titleOf(summary: SessionSummary): string {
  const title = summary.projections?.values?.title;
  if (typeof title === "string" && title.trim() !== "") return title;
  return "新会话";
}

/** `YYYY-MM-DD` in the user's own timezone — usage is read as "which day was that". */
function localDate(ts: number): string {
  const at = new Date(ts);
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/** Queue items carry the full message envelope; the strip only shows what was typed. */
function queueText(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((block: any) => (block?.type === "text" ? String(block.text ?? "") : ""))
    .join("")
    .trim();
}

function describeError(error: unknown): string {
  if (error instanceof DshError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useKernel(): Kernel {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [host, setHost] = useState<HostDescription | null>(null);
  const [version, setVersion] = useState("");
  const [themePreference, setThemeState] = useState<ThemePreference>("system");
  const [theme, setResolvedTheme] = useState<"light" | "dark">("light");
  /* Last known `ui-theme` revision, so the palette's toggle can write without a
     round trip. null = unknown, which forces a describe before the next write. */
  const themeRevision = useRef<number | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [searchHits, setSearchHits] = useState<SessionSearchHit[] | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  /* Shell-owned preferences; see shellPrefs.ts for why they are not dsh settings. */
  const [uiFontSize, setUiFontSizeState] = useState(DEFAULT_FONT_SIZE);
  const [startDir, setStartDirState] = useState("");
  const [notifyOnIdle, setNotifyOnIdleState] = useState(true);
  /* The status frame reports the new value, not the edge — keep the old one. */
  const streamingRef = useRef(false);
  const notifyRef = useRef(true);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [dialogRequest, setDialogRequest] = useState<UIDialogRequest | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [models, setModels] = useState<ModelsView | null>(null);
  /* The prompt callback must not re-create on every model switch, so the id it
     needs at failure time rides a ref. */
  const modelRef = useRef("");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [projections, setProjections] = useState<ProjectionValues>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeyPrompt, setApiKeyPrompt] = useState<"none" | "open">("none");
  const [bootError, setBootError] = useState("");
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [pluginsBusy, setPluginsBusy] = useState(false);
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [subagents, setSubagents] = useState<SubagentEntry[]>([]);
  const [agentPresets, setAgentPresets] = useState<AgentPreset[]>([]);
  const [presetsAuthorable, setPresetsAuthorable] = useState(false);
  const [currentPreset, setCurrentPreset] = useState("");

  const timeline = useRef(new Timeline());
  const sessionRef = useRef("");
  const workspacesRef = useRef<WorkspaceView[]>([]);
  /** Sessions the user archived. `session.list` still returns them. */
  const archivedRef = useRef<Set<string>>(new Set());
  /** The lowest seq folded so far, and whether anything sits above it. */
  const oldestRef = useRef<number | undefined>(undefined);
  const moreRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const bootedRef = useRef(false);
  /* True between a downlink closing and the next one opening — the two streams
     drop and reopen independently, so the toast pair has to be edge-triggered. */
  const droppedRef = useRef(false);
  const searchTimer = useRef<number | null>(null);
  /* Per-key watermark of the projection store: a frame older than what is held
     is dropped, so a late mux frame cannot undo a fresher history baseline. */
  const projectionSeq = useRef<Map<string, number>>(new Map());
  /* One dialog is on screen at a time. The runtime can raise an approval while a
     local prompt is open, so requests wait in line instead of clobbering. */
  const dialogQueue = useRef<PendingDialog[]>([]);
  const activeDialog = useRef<PendingDialog | null>(null);
  /** sessionId → cwd, from `session.list`. Attaching a stored session needs it. */
  const cwdOf = useRef<Map<string, string>>(new Map());
  /** sessionId → agent preset id, same source. Empty string = the default one. */
  const presetOf = useRef<Map<string, string>>(new Map());
  /** Child session ids of the open session, for recognising their status frames. */
  const subagentIds = useRef<Set<string>>(new Set());
  /** attachmentId → data URL. Attachment bytes are immutable, so this never stales. */
  const attachmentCache = useRef<Map<string, string>>(new Map());
  /* rpcIds the runtime already resolved on its own (timeout, another client,
     cancelled turn). Answering one of those would be a protocol violation. */
  const settledRemote = useRef<Set<string>>(new Set());
  /* `approval/resolved` names the approval, not the rpc, so the open dialog can
     only be withdrawn through this side table. */
  const approvalRpc = useRef<Map<string, string>>(new Map());

  /* Toasts are transient by design: nothing in the shell dismisses them, so
     without this timer the last message stays on screen for the whole session. */
  const notifyTimer = useRef<number | null>(null);
  const notify = useCallback((text: string, kind: Notification["kind"] = "info") => {
    setNotification({ text, kind });
    if (notifyTimer.current !== null) window.clearTimeout(notifyTimer.current);
    notifyTimer.current = window.setTimeout(
      () => {
        notifyTimer.current = null;
        setNotification(null);
      },
      /* Errors are worth reading twice. */
      kind === "error" ? 7000 : 4000
    );
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      notify(describeError(error), "error");
    },
    [notify]
  );

  /* Token deltas arrive faster than the display refreshes; one render per frame
     keeps a long stream from re-rendering the timeline hundreds of times a second. */
  const flush = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setMessages(timeline.current.snapshot());
    });
  }, []);

  const applySessionList = useCallback((items: SessionSummary[]) => {
    /* Kept for the attach step in loadSession: adopting a stored session needs
       the cwd its header was written with, and only the list carries it. */
    for (const item of items) if (item.cwd) cwdOf.current.set(item.sessionId, item.cwd);
    /* The preset a session runs under is not a projection — the list row is the
       only place it is readable without replaying the log. */
    for (const item of items) presetOf.current.set(item.sessionId, item.agentPreset ?? "");
    const held = presetOf.current.get(sessionRef.current);
    if (held !== undefined) setCurrentPreset(held);
    const visible = items
      /* Subagent children are internal threads owned by a parent turn; they show
         up under the message that spawned them, never as conversations. */
      .filter((item) => item.origin !== "subagent")
      .filter((item) => !archivedRef.current.has(item.sessionId))
      .filter((item) => !item.blank || item.sessionId === sessionRef.current)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    setSessions(
      visible.map<SessionMeta>((item) => ({
        id: item.sessionId,
        title: titleOf(item),
        cwd: item.cwd ?? "",
        updatedAt: item.updatedAt,
        messageCount: 0,
      }))
    );
  }, []);

  const refreshSessions = useCallback(() => {
    call<{ items: SessionSummary[] }>("session.list")
      .then(({ items }) => applySessionList(items))
      .catch(fail);
  }, [applySessionList, fail]);

  /**
   * Workspaces are dsh's durable project list, and its archive set lives on the
   * same call — so both land together or the sidebar shows archived sessions.
   */
  const refreshWorkspaces = useCallback(() => {
    call<{ items: WorkspaceView[]; archivedSessionIds: string[] }>("workspace.list")
      .then(({ items, archivedSessionIds }) => {
        workspacesRef.current = items;
        archivedRef.current = new Set(archivedSessionIds);
        setWorkspaces(items);
        refreshSessions();
      })
      .catch(fail);
  }, [fail, refreshSessions]);

  /** Show the next queued dialog, if the screen is free. */
  const pumpDialogs = useCallback(() => {
    if (activeDialog.current) return;
    const next = dialogQueue.current.shift() ?? null;
    activeDialog.current = next;
    setDialogRequest(next?.request ?? null);
  }, []);

  const ask = useCallback(
    (request: UIDialogRequest) =>
      new Promise<DialogResult>((resolve) => {
        dialogQueue.current.push({ request, resolve });
        pumpDialogs();
      }),
    [pumpDialogs]
  );

  /** A question batch numbers its dialogs; the rpcId is the part before the `#`. */
  const ownsDialog = (dialogId: string, rpcId: string) =>
    dialogId === rpcId || dialogId.startsWith(`${rpcId}#`);

  /** Withdraw a dialog the runtime resolved elsewhere; nothing is sent back. */
  const withdrawDialog = useCallback(
    (id: string) => {
      settledRemote.current.add(id);
      const dropped = dialogQueue.current.filter((item) => ownsDialog(item.request.id, id));
      dialogQueue.current = dialogQueue.current.filter((item) => !ownsDialog(item.request.id, id));
      /* Resolve rather than abandon: a question batch is awaiting this promise,
         and it checks `settledRemote` before it would answer. */
      for (const item of dropped) item.resolve(null);
      const active = activeDialog.current;
      if (active && ownsDialog(active.request.id, id)) {
        activeDialog.current = null;
        setDialogRequest(null);
        active.resolve(null);
        pumpDialogs();
      }
    },
    [pumpDialogs]
  );

  const resolveDialog = useCallback(
    (id: string, result: DialogResult) => {
      const active = activeDialog.current;
      if (!active || active.request.id !== id) return;
      activeDialog.current = null;
      setDialogRequest(null);
      active.resolve(result);
      pumpDialogs();
    },
    [pumpDialogs]
  );

  /** Only reads the status the settings row shows — the key is set from there. */
  const ensureApiKey = useCallback(async () => {
    const { credentials } = await call<{
      credentials: Record<string, { configured: boolean }>;
    }>("credentials.describe", { refs: [DEEPSEEK_KEY_REF] });
    setApiKeyConfigured(credentials[DEEPSEEK_KEY_REF]?.configured === true);
  }, []);

  const setApiKey = useCallback(() => setApiKeyPrompt("open"), []);

  const dismissApiKeyPrompt = useCallback(() => setApiKeyPrompt("none"), []);

  const saveApiKey = useCallback(
    async (value: string) => {
      await call("credentials.set", { ref: DEEPSEEK_KEY_REF, value: value.trim() });
      setApiKeyConfigured(true);
      setApiKeyPrompt("none");
      notify("API key 已保存", "success");
    },
    [notify]
  );

  /**
   * Fold projection values in under higher-seq-wins.
   *
   * The history tail page carries one `asOfSeq` for the whole block while mux
   * frames carry a per-unit watermark, so the store keeps a seq per key.
   */
  const mergeProjections = useCallback((values: ProjectionValues, seq: number) => {
    const fresh: ProjectionValues = {};
    for (const [key, value] of Object.entries(values)) {
      const held = projectionSeq.current.get(key);
      if (held !== undefined && held > seq) continue;
      projectionSeq.current.set(key, seq);
      fresh[key] = value;
    }
    if (Object.keys(fresh).length === 0) return;
    setProjections((current) => ({ ...current, ...fresh }));
  }, []);

  /**
   * The children this session delegated to.
   *
   * Parent-side only: a child's own `subagent` projection carries its identity,
   * but the parent has no projection listing them, so this is a read.
   */
  const loadSubagents = useCallback((id: string) => {
    if (!id) {
      subagentIds.current = new Set();
      setSubagents([]);
      return;
    }
    call<{ entries: any[] }>("subagent.list", { parentSessionId: id })
      .then(({ entries }) => {
        if (sessionRef.current !== id) return;
        const children = (entries ?? []).filter(
          (entry) => entry?.kind === "child" && typeof entry.id === "string"
        );
        /* Held apart from state so a child's status frame can be recognised
           without rebuilding the frame handler on every list change. */
        subagentIds.current = new Set(children.map((entry) => entry.id as string));
        setSubagents(
          children
            .map((entry) => ({
              id: entry.id,
              mode: entry.mode === "continuable" ? "continuable" : "one-shot",
              activity: entry.activity === "running" ? "running" : "inactive",
              label: typeof entry.label === "string" ? entry.label : "",
              hasChildren: entry.hasChildren === true,
            }))
        );
      })
      /* A detached session has no live agent to ask, which is not an error the
         person needs to see — it just means there is nothing to list. */
      .catch(() => {
        if (sessionRef.current !== id) return;
        subagentIds.current = new Set();
        setSubagents([]);
      });
  }, []);

  const refreshSubagents = useCallback(() => {
    loadSubagents(sessionRef.current);
  }, [loadSubagents]);

  /** Models, skills and slash commands are all per-session. */
  const refreshCapabilities = useCallback(
    (id: string) => {
      call<ModelsView>("session.models", { sessionId: id })
        .then((view) => {
          if (sessionRef.current !== id) return;
          setModels(view);
          modelRef.current = view.current?.model ?? "";
        })
        .catch(fail);
      call<{ skills: (SkillInfo & { modelInvocable?: boolean })[] }>("skill.list", {
        sessionId: id,
      })
        .then(({ skills: items }) => {
          if (sessionRef.current !== id) return;
          setSkills(items.map(({ name, description }) => ({ name, description })));
        })
        .catch(fail);
      call<{ name: string; description: string; input?: { hint?: string } }[]>(COMMANDS_METHOD, {
        args: { agentId: id },
      })
        .then((items) => {
          if (sessionRef.current !== id) return;
          setCommands(
            items.map(({ name, description, input }) => ({
              name,
              description: description ?? "",
              hint: input?.hint,
            }))
          );
        })
        .catch(fail);
      loadSubagents(id);
      /* Presets are host-global, but the catalogue can change under an editor,
         so it is read on the same beat as everything else session-scoped. */
      call<{ presets: any[]; authorable?: boolean; hasDocument?: boolean }>("agentPreset.list", {})
        .then(({ presets, authorable, hasDocument }) => {
          setAgentPresets(
            (presets ?? []).map((preset) => ({
              id: String(preset.id),
              name: preset.name ?? String(preset.id),
              description: preset.description ?? "",
              isDefault: preset.isDefault === true,
              broken: preset.broken ?? "",
              trust: preset.trust === "user" ? "user" : "system",
            }))
          );
          /* Authoring needs both: a writable preset dir and a document to open. */
          setPresetsAuthorable(authorable === true && hasDocument === true);
        })
        .catch(fail);
    },
    [fail, loadSubagents]
  );

  /** Record where the loaded window starts, so the next page knows where to cut. */
  const takePage = useCallback(
    (page: HistoryPage) => {
      for (const entry of page.events) timeline.current.apply(entry.event);
      /* Only the tail page carries a projections block — it is the meter's
         baseline, and mux frames take it from there. */
      const values = page.projections?.values;
      if (values) mergeProjections(values, page.projections?.asOfSeq ?? 0);
      const first = page.events[0]?.event.seq;
      const previous = oldestRef.current;
      /* A page that reaches no further back than the last one ends the walk,
         whatever it claims: paging on the same cut would repeat forever. */
      const advanced = first !== undefined && (previous === undefined || first < previous);
      if (advanced) oldestRef.current = first;
      const more = page.hasMore && (advanced || previous === undefined);
      moreRef.current = more;
      setHasMoreHistory(more);
      setMessages(timeline.current.snapshot());
    },
    [mergeProjections]
  );

  const loadSession = useCallback(
    async (id: string) => {
      sessionRef.current = id;
      setSessionId(id);
      timeline.current.reset();
      setMessages([]);
      setQueue([]);
      oldestRef.current = undefined;
      moreRef.current = false;
      setHasMoreHistory(false);
      projectionSeq.current.clear();
      setProjections({});
      setModels(null);
      modelRef.current = "";
      setJobs([]);
      setSubagents([]);
      setCurrentPreset(presetOf.current.get(id) ?? "");
      /* Attach before reading capabilities. History serves detached sessions off
         the log, but `skill.list` documents that it never resumes an agent and
         answers `session-not-found` on a session no one has adopted — as does
         `session.cancel`. `session.create` with an existing id is the adoption
         path; it demands the stored cwd, so a session we have no cwd for (one we
         just created, already attached) is left alone. */
      const cwd = cwdOf.current.get(id);
      if (cwd !== undefined) {
        await call("session.create", { sessionId: id, cwd }).catch(fail);
      }
      /* No beforeSeq: the tail page is the window the runtime considers current. */
      takePage(await call<HistoryPage>("session.history", { sessionId: id }));
      refreshCapabilities(id);
    },
    [fail, refreshCapabilities, takePage]
  );

  /**
   * Page one window further back.
   *
   * `beforeSeq` is exclusive, so the oldest seq held is the right cut: the fold
   * would drop a repeat anyway, but re-sending it would stall the cursor.
   */
  const loadMoreHistory = useCallback(() => {
    const id = sessionRef.current;
    const before = oldestRef.current;
    if (!id || before === undefined || !moreRef.current) return;
    setIsLoadingHistory(true);
    call<HistoryPage>("session.history", { sessionId: id, beforeSeq: before })
      .then((page) => {
        /* The session may have been switched while the page was in flight. */
        if (sessionRef.current !== id) return;
        takePage(page);
      })
      .catch(fail)
      .finally(() => setIsLoadingHistory(false));
  }, [fail, takePage]);

  /**
   * Tool approval.
   *
   * The frame's rpcId is the answer's address — it is echoed, never minted, and
   * the dialog carries it as its own id so the reply cannot be misrouted.
   * Rejecting is the safe default, so a dismissed dialog means "rejected".
   */
  const handleApproval = useCallback(
    (rpcId: string, payload: any) => {
      approvalRpc.current.set(String(payload.approvalId), rpcId);
      ask({
        id: rpcId,
        dialogType: "confirm",
        title: "需要授权",
        message: `Agent 要使用 ${payload.toolName}。`,
        detail: typeof payload.reason === "string" ? payload.reason : undefined,
        okLabel: "允许一次",
        cancelLabel: "拒绝",
      })
        .then((result) => {
          approvalRpc.current.delete(String(payload.approvalId));
          if (settledRemote.current.has(rpcId)) return;
          const allowed = !!result && "confirmed" in result && result.confirmed;
          return respond(rpcId, {
            ok: true,
            value: {
              sessionId: payload.sessionId,
              approvalId: payload.approvalId,
              outcome: allowed ? "allowed-once" : "rejected",
            },
          });
        })
        .catch(fail);
    },
    [ask, fail]
  );

  /**
   * User questions.
   *
   * One `ask()` carries a batch and takes one answer, so the questions are shown
   * in turn and only the completed batch is sent. Dismissing any of them cancels
   * the whole request — a half-filled batch has no encoding.
   */
  const handleQuestions = useCallback(
    (rpcId: string, payload: any) => {
      const questions: any[] = Array.isArray(payload.questions) ? payload.questions : [];
      if (questions.length === 0) return;

      (async () => {
        const answers: { id: string; selected: string[]; custom?: string }[] = [];
        for (const [index, question] of questions.entries()) {
          const options: any[] = Array.isArray(question.options) ? question.options : [];
          const base = {
            id: `${rpcId}#${index}`,
            title: question.header ? String(question.header) : "Agent 的问题",
            message: String(question.question ?? ""),
            detail: typeof question.detail === "string" ? question.detail : undefined,
          };
          const result = await ask(
            options.length > 0
              ? {
                  ...base,
                  dialogType: "select",
                  options: options.map((option) => ({
                    label: String(option.label),
                    value: String(option.label),
                    description:
                      typeof option.description === "string" ? option.description : undefined,
                  })),
                  multiSelect: question.multiSelect === true,
                  /* Core keeps a free-text slot next to the options on every
                     question, so the answer is never forced into the menu. */
                  allowCustom: true,
                }
              : { ...base, dialogType: "input", placeholder: "回答…" }
          );
          if (settledRemote.current.has(rpcId)) return;
          if (result === null) {
            await respond(rpcId, {
              ok: false,
              error: { code: "cancelled", message: "用户关闭了这个提问", details: {} },
            }).catch(fail);
            return;
          }
          /* Selected labels are the wire form — an option has no separate id. */
          if ("values" in result) {
            answers.push({ id: String(question.id), selected: result.values, custom: result.custom });
          } else if ("value" in result) {
            answers.push({ id: String(question.id), selected: [], custom: result.value });
          }
        }
        if (settledRemote.current.has(rpcId)) return;
        await respond(rpcId, {
          ok: true,
          value: { sessionId: payload.sessionId, answer: { answers } },
        }).catch(fail);
      })().catch(fail);
    },
    [ask, fail]
  );

  const handleFrame = useCallback(
    ({ stream, rpcId, payload }: FramePayload) => {
      if (stream === "mux") {
        if (payload.sessionId !== undefined && payload.sessionId !== sessionRef.current) return;
        switch (payload.type) {
          case "session/event": {
            if (!payload.event) return;
            /* A turn can end on an error the log records but the timeline shows
               nothing for — an unusable Model, a provider refusal. Surface it, or
               the prompt just silently does nothing. */
            const reason = payload.event.data?.reason;
            if (payload.event.type === "turn/end") {
              if (reason?.kind === "error") {
                notify(String(reason.error?.message ?? "这一轮出错了"), "error");
              }
              /* Children settle with the turn that delegated to them. */
              refreshSubagents();
            }
            if (timeline.current.apply(payload.event)) flush();
            return;
          }
          case "session/jobs": {
            const items = Array.isArray(payload.jobs) ? payload.jobs : [];
            setJobs(
              items.map((job: any) => ({
                id: String(job.id),
                kind: String(job.kind ?? ""),
                label: String(job.label ?? ""),
                status: String(job.status ?? "running"),
                detail: job.detail,
                startedAt: Number(job.startedAt ?? 0),
                finishedAt: job.finishedAt,
              }))
            );
            return;
          }
          case "session/queue": {
            const items = Array.isArray(payload.items) ? payload.items : [];
            setQueue(
              items
                /* `context` items are runtime-injected, not something the person
                   queued — showing them would offer a cancel button for the
                   session's own bookkeeping. */
                .filter((item: any) => item?.placement !== "context")
                .map((item: any) => ({
                  id: String(item.id),
                  placement: item.placement,
                  text: queueText(item.message),
                }))
                .filter((item: QueuedPrompt) => item.text !== "")
            );
            return;
          }
          case "session/projection": {
            if (typeof payload.key !== "string") return;
            mergeProjections({ [payload.key]: payload.value }, payload.seq ?? 0);
            /* The title is derived from the first turn, so it lands after the
               session is already in the sidebar under its placeholder name. */
            if (payload.key === "title") refreshSessions();
            return;
          }
          case "approval/requested":
            handleApproval(rpcId, payload);
            return;
          case "approval/resolved": {
            /* Resolved elsewhere — a cancelled turn, another client, a timeout.
               Take the dialog down instead of answering a dead rpcId. */
            const owner = approvalRpc.current.get(String(payload.approvalId));
            if (owner) {
              approvalRpc.current.delete(String(payload.approvalId));
              withdrawDialog(owner);
            }
            return;
          }
          case "question/requested":
            handleQuestions(rpcId, payload);
            return;
          case "question/resolved":
            if (typeof payload.questionRpcId === "string") withdrawDialog(payload.questionRpcId);
            return;
          case "stream/error":
            notify(String(payload.error?.message ?? "运行时数据流出错"), "error");
            return;
          default:
            return;
        }
      }
      switch (payload.type) {
        case "host/session-status":
          if (payload.sessionId === sessionRef.current) {
            const running = payload.running === true;
            /* A turn that lands behind another window is the whole reason this
               exists — an agent run is long enough that nobody sits watching. */
            if (!running && streamingRef.current && notifyRef.current && !document.hasFocus()) {
              void requestAttention().catch(() => {});
            }
            streamingRef.current = running;
            setIsStreaming(running);
          } else if (subagentIds.current.has(String(payload.sessionId))) {
            refreshSubagents();
          }
          return;
        case "host/agent-error":
          notify(String(payload.message ?? "Agent 出错"), "error");
          return;
        case "host/session-added":
          /* A subagent session is a child, not a sidebar row — but it does mean
             this session just delegated something. */
          if (payload.origin === "subagent") {
            if (payload.parentSessionId === sessionRef.current) refreshSubagents();
            return;
          }
          refreshSessions();
          return;
        case "host/session-removed":
          refreshSessions();
          return;
        case "host/remote-event":
          /* The preset a session runs under changes through a command, and the
             only announcement is this relayed cordis event. */
          if (payload.event === "agent-preset/selected") {
            const [target, preset] = (payload.args ?? []) as unknown[];
            if (target === sessionRef.current) setCurrentPreset(String(preset ?? ""));
          }
          return;
        case "host/workspace-changed":
        case "host/workspace-removed":
        case "host/workspace-order-changed":
        case "host/archived-sessions-changed":
          refreshWorkspaces();
          return;
        default:
          return;
      }
    },
    [
      flush,
      handleApproval,
      handleQuestions,
      mergeProjections,
      notify,
      refreshSessions,
      refreshSubagents,
      refreshWorkspaces,
      withdrawDialog,
    ]
  );

  const handleFrameRef = useRef(handleFrame);
  handleFrameRef.current = handleFrame;

  useEffect(() => {
    let abandoned = false;
    const cleanups: UnlistenFn[] = [];

    const keep = (unlisten: UnlistenFn) => {
      if (abandoned) unlisten();
      else cleanups.push(unlisten);
    };

    (async () => {
      try {
        /* Subscribe before starting: the runtime opens its streams during
           `dsh_start`, and a frame that arrives unlistened is simply lost. */
        keep(await onFrame((frame) => handleFrameRef.current(frame)));
        keep(
          await onStream(({ state }) => {
            /* Both downlinks reopen on their own; the shell only has to follow
               them, because the composer is gated on `connection`. Without the
               "open" half a single hiccup left the input disabled for good. */
            if (state === "closed") {
              if (!droppedRef.current) {
                droppedRef.current = true;
                setConnection("connecting");
                notify("和 dsh 运行时的连接断了，正在重连…", "error");
              }
            } else if (droppedRef.current) {
              droppedRef.current = false;
              setConnection("connected");
              notify("连接已恢复", "info");
            }
          })
        );
        if (abandoned || bootedRef.current) return;
        bootedRef.current = true;

        await startRuntime();
        const description = await call<HostDescription>("host.describe");
        if (abandoned) return;
        setHost(description);
        /* The shell owns the theme: dsh stores the preference but the plugin that
           acts on it is one of the ui-* browser plugins we do not load. */
        call<SettingsSnapshot>("settings.describe", {})
          .then((snapshot) => {
            const view = snapshot.namespaces.find((item) => item.ns === THEME_NS);
            themeRevision.current = view?.revision ?? null;
            syncTheme(asPreference(view?.value?.[THEME_KEY]));
          })
          .catch(() => syncTheme("system"));
        runtimeVersion()
          .then((version) => !abandoned && setVersion(version))
          .catch(() => setVersion(""));

        const { items: spaces, archivedSessionIds } = await call<{
          items: WorkspaceView[];
          archivedSessionIds: string[];
        }>("workspace.list");
        if (abandoned) return;
        workspacesRef.current = spaces;
        archivedRef.current = new Set(archivedSessionIds);
        setWorkspaces(spaces);

        const { items } = await call<{ items: SessionSummary[] }>("session.list");
        if (abandoned) return;
        /* Seeds the cwd map loadSession attaches with; the sidebar's own refresh
           runs later, and the first session is opened before it. */
        applySessionList(items);
        const newest = items
          .filter((item) => item.origin !== "subagent")
          .filter((item) => !archivedRef.current.has(item.sessionId))
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        const id =
          newest?.sessionId ?? (await call<{ sessionId: string }>("session.create", {})).sessionId;
        await loadSession(id);
        if (abandoned) return;

        setConnection("connected");
        setBootError("");
        refreshSessions();
        await ensureApiKey();
      } catch (error) {
        if (abandoned) return;
        setConnection("error");
        setBootError(describeError(error));
      }
    })();

    return () => {
      abandoned = true;
      for (const unlisten of cleanups) unlisten();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, [applySessionList, ensureApiKey, loadSession, notify, refreshSessions]);

  const prompt = useCallback(
    async (text: string, streamingBehavior: StreamingBehavior = "followUp", images: PromptImage[] = []) => {
      const id = sessionRef.current;
      if (!id) {
        notify("还没有会话", "error");
        return false;
      }
      /* An image never rides the wire as an image: DeepSeek takes no image input,
         so a block like that fails the whole turn. Each one is stored by
         `describe-image` first and enters the message as a one-line reference —
         which the model resolves by calling its tool. References lead, because a
         caption reads as a caption only when it follows what it describes. */
      let body = text;
      if (images.length > 0) {
        try {
          const references = await Promise.all(
            images.map((image) => attachImage(image.mediaType, image.data, image.name))
          );
          body = [...references, ...(text === "" ? [] : [text])].join("\n\n");
        } catch (error) {
          fail(error);
          return false;
        }
      }
      const content = body === "" ? [] : [{ type: "text", text: body }];
      if (content.length === 0) return false;
      try {
        await call("session.prompt", {
          sessionId: id,
          mode: streamingBehavior === "steer" ? "steer" : "queue",
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    [fail]
  );

  /**
   * Fetch one image attachment.
   *
   * The durable message holds a reference, not the bytes, so every rendered
   * image is a round trip — cached here because the timeline re-renders far more
   * often than the log changes.
   */
  const loadAttachment = useCallback(async (attachmentId: string) => {
    const held = attachmentCache.current.get(attachmentId);
    if (held) return held;
    const id = sessionRef.current;
    if (!id) return "";
    const { attachment, data } = await call<{
      attachment: { mediaType: string };
      data: string;
    }>("session.attachment", { sessionId: id, attachmentId });
    const url = `data:${attachment.mediaType};base64,${data}`;
    attachmentCache.current.set(attachmentId, url);
    return url;
  }, []);

  const abort = useCallback(() => {
    const id = sessionRef.current;
    if (!id) return;
    call("session.cancel", { sessionId: id }).catch(fail);
  }, [fail]);

  const removeQueued = useCallback(
    (itemId: string) => {
      const id = sessionRef.current;
      if (!id) return;
      call("session.updateQueue", { sessionId: id, itemId, action: { kind: "remove" } }).catch(fail);
    },
    [fail]
  );

  const openSession = useCallback(
    (id: string) => {
      loadSession(id).catch(fail);
    },
    [fail, loadSession]
  );

  const newSession = useCallback(() => {
    const dir = readStartDir();
    call<{ sessionId: string }>("session.create", dir === "" ? {} : { cwd: dir })
      .then(({ sessionId: id }) => loadSession(id))
      .then(refreshSessions)
      .catch(fail);
  }, [fail, loadSession, refreshSessions]);

  /**
   * Fork at a message.
   *
   * `atSeq` names the log position to cut at, which is why the fold keeps every
   * message's originating seq. Without an anchor dsh forks the whole session.
   */
  const forkSession = useCallback(
    (entryId?: string) => {
      const id = sessionRef.current;
      if (!id) return;
      const atSeq = entryId === undefined ? undefined : timeline.current.seqOf(entryId);
      call<{ sessionId: string }>("session.fork", { sessionId: id, atSeq })
        .then(({ sessionId: child }) => loadSession(child))
        .then(refreshSessions)
        .catch(fail);
    },
    [fail, loadSession, refreshSessions]
  );

  /**
   * Full-text session search.
   *
   * The index is opt-in — the app turns it on through its own `--patch` overlay.
   * Measured 2026-08-15: the tokenizer splits on script boundaries, so a Chinese
   * query only matches a whole run. The sidebar keeps its own title filter for
   * that reason; these hits widen the result set, they do not replace it.
   */
  const searchSessions = useCallback(
    (query: string) => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      const trimmed = query.trim();
      if (trimmed === "") {
        setSearchHits(null);
        return;
      }
      searchTimer.current = window.setTimeout(() => {
        searchTimer.current = null;
        call<{ items: SessionSearchHit[] }>("session.search", { query: trimmed })
          .then(({ items }) => setSearchHits(items))
          /* Silent: the sidebar still filters locally, and a toast per keystroke
             would be worse than the missing hits. */
          .catch(() => setSearchHits(null));
      }, SEARCH_DEBOUNCE);
    },
    []
  );

  const renameSession = useCallback(
    (id: string) => {
      const current = sessions.find((item) => item.id === id)?.title ?? "";
      ask({
        id: "rename-session",
        dialogType: "input",
        title: "重命名会话",
        placeholder: "会话名",
        prefill: current,
      })
        .then((result) => {
          const title = result && "value" in result ? result.value.trim() : "";
          if (title === "") return;
          return call("session.rename", { sessionId: id, title }).then(refreshSessions);
        })
        .catch(fail);
    },
    [ask, fail, refreshSessions, sessions]
  );

  /** dsh archives rather than deletes: the log stays on disk, the sidebar drops it. */
  const deleteSession = useCallback(
    (id: string) => {
      ask({
        id: "archive-session",
        dialogType: "confirm",
        title: "归档会话",
        message: "会话记录仍留在磁盘上，只是不再显示在侧栏。",
      })
        .then((result) => {
          if (!result || !("confirmed" in result) || !result.confirmed) return;
          return call<{ archivedSessionIds: string[] }>("workspace.archiveSession", {
            sessionId: id,
          }).then(({ archivedSessionIds }) => {
            archivedRef.current = new Set(archivedSessionIds);
            refreshSessions();
            if (sessionRef.current === id) newSession();
          });
        })
        .catch(fail);
    },
    [ask, fail, newSession, refreshSessions]
  );

  const workspaceAt = useCallback(
    (path: string) => workspacesRef.current.find((space) => space.path === path),
    []
  );

  const addProject = useCallback(() => {
    pickDirectory()
      .then((path) => {
        if (!path) return;
        return call<{ workspace: WorkspaceView }>("workspace.create", { path })
          .then(({ workspace }) =>
            call<{ sessionId: string }>("session.create", { workspaceId: workspace.workspaceId })
          )
          .then(({ sessionId: id }) => loadSession(id))
          .then(refreshWorkspaces);
      })
      .catch(fail);
  }, [fail, loadSession, refreshWorkspaces]);

  /** dsh has no pin flag — the workspace order is the order, so this moves it up. */
  const pinProject = useCallback(
    (cwd: string) => {
      const space = workspaceAt(cwd);
      const first = workspacesRef.current[0];
      if (!space || !first || first.workspaceId === space.workspaceId) return;
      call("workspace.insertBefore", {
        workspaceId: space.workspaceId,
        beforeWorkspaceId: first.workspaceId,
      })
        .then(refreshWorkspaces)
        .catch(fail);
    },
    [fail, refreshWorkspaces, workspaceAt]
  );

  const newSessionInProject = useCallback(
    (cwd: string) => {
      const space = workspaceAt(cwd);
      /* A session can sit in a directory that was never adopted as a workspace —
         the runtime's own cwd, for one. Create by path in that case. */
      const payload = space ? { workspaceId: space.workspaceId } : { cwd };
      call<{ sessionId: string }>("session.create", payload)
        .then(({ sessionId: id }) => loadSession(id))
        .then(refreshSessions)
        .catch(fail);
    },
    [fail, loadSession, refreshSessions, workspaceAt]
  );

  /** A session's cwd is fixed when it is created, so binding means a new session. */
  const bindProject = useCallback(
    (cwd: string | null) => {
      if (cwd === null) {
        newSession();
        return;
      }
      newSessionInProject(cwd);
    },
    [newSession, newSessionInProject]
  );

  const deleteProject = useCallback(
    (cwd: string) => {
      const space = workspaceAt(cwd);
      if (!space) {
        notify("这个目录不是 workspace，没有可删除的记录", "info");
        return;
      }
      ask({
        id: "delete-workspace",
        dialogType: "confirm",
        title: "移除项目",
        message: `把 ${space.title} 从项目列表里移除。会话记录不受影响。`,
      })
        .then((result) => {
          if (!result || !("confirmed" in result) || !result.confirmed) return;
          return call("workspace.delete", { workspaceId: space.workspaceId }).then(
            refreshWorkspaces
          );
        })
        .catch(fail);
    },
    [ask, fail, notify, refreshWorkspaces, workspaceAt]
  );

  /**
   * Run a slash command.
   *
   * Measured 2026-08-16: `session.prompt` does NOT dispatch a leading slash —
   * `/definitely-not-a-command` is answered `{ accepted: true }` and reaches the
   * model as ordinary text. Commands ride the same remote channel as
   * `commands/list`, which is the only path that actually executes them.
   */
  const runCommand = useCallback(
    (line: string) => {
      const id = sessionRef.current;
      if (!id) return;
      call<{ commandId?: string; result?: { kind: string; text?: string } } | undefined>(
        COMMANDS_EXECUTE,
        { args: { agentId: id, line } }
      )
        .then((outcome) => {
          /* An unrecognized name answers ok with nothing at all — no error to
             catch — so silence is the signal that nothing ran. */
          if (!outcome?.result) {
            notify(`没有这个命令：${line}`, "error");
            return;
          }
          const text = translateReceipt(outcome.result.text);
          if (text) notify(text, outcome.result.kind === "success" ? "success" : "error");
          /* A command can change the route or the command set itself. */
          refreshCapabilities(id);
        })
        .catch(fail);
    },
    [fail, notify, refreshCapabilities]
  );

  const executeCommand = useCallback(
    (name: string) => {
      runCommand(`/${name}`);
    },
    [runCommand]
  );

  /** Compaction is a host command, not an RPC. */
  const compact = useCallback(() => {
    runCommand("/compact");
  }, [runCommand]);

  /* ---------------- 计划模式 / 目标 / 待办 / 权限 ---------------- */

  const plan = useMemo(() => readPlan(projections), [projections]);
  const goal = useMemo(() => readGoal(projections), [projections]);
  const todos = useMemo(() => readTodos(projections), [projections]);
  const permission = useMemo(() => readPermission(projections), [projections]);
  const imageLimits = useMemo(() => readImageLimits(projections), [projections]);

  /**
   * Plan mode has no RPC.
   *
   * Measured 2026-08-16 against the live method map: neither plan mode nor the
   * permission preset is in it — `/plan`, `/plan off` and `/permission <value>`
   * are the whole write surface. Reading them is a projection, so the state on
   * screen is still the runtime's, not ours.
   */
  const togglePlanMode = useCallback(() => {
    runCommand(plan.active ? "/plan off" : "/plan");
  }, [plan.active, runCommand]);

  /**
   * Write one settings namespace, reading its revision first.
   *
   * Every "…and this is what the next session starts from" write goes through
   * here. The panels carry no separate default control, so the picker that
   * changes the live session has to carry both scopes itself.
   *
   * @returns false when the runtime never registered the namespace.
   */
  const writeSettings = useCallback(
    async (ns: string, ops: { op: "set"; path: string[]; value: unknown }[]) => {
      const snapshot = await call<SettingsSnapshot>("settings.describe", {});
      const view = snapshot.namespaces.find((entry) => entry.ns === ns);
      if (!view) return false;
      await call<SettingsNamespaceView>("settings.mutate", {
        ns,
        ops,
        expectedRevision: view.revision,
      });
      return true;
    },
    []
  );

  /**
   * `/permission` moves the running session; the settings write moves every
   * session after it. Two RPCs, one choice — a preference the user set once
   * should not reset itself on the next 新建会话.
   */
  const setPermission = useCallback(
    (value: string) => {
      runCommand(`/permission ${value}`);
      /* Best effort: the visible half already landed, so a failed default is
         not worth a toast on top of the one runCommand may already show. */
      void writeSettings(PERMISSION_NS, [
        { op: "set", path: [PERMISSION_DEFAULT_KEY], value },
      ]).catch(() => {});
    },
    [runCommand, writeSettings]
  );

  /** Creating a goal while one is current replaces it — the runtime bumps the revision. */
  const setGoal = useCallback(
    async (objective: string) => {
      const id = sessionRef.current;
      const text = objective.trim();
      if (!id || text === "") return;
      try {
        await call("goal.create", { sessionId: id, objective: text });
      } catch (error) {
        fail(error);
      }
    },
    [fail]
  );

  /* Every goal write is addressed by `{id, revision}`: the runtime rejects a
     stale revision rather than applying it to a goal that moved on. */
  const updateGoal = useCallback(
    (action: "pause" | "resume" | "complete" | "clear") => {
      const id = sessionRef.current;
      if (!id || !goal) return;
      call(`goal.${action}`, {
        sessionId: id,
        ref: { id: goal.id, revision: goal.revision },
      }).catch(fail);
    },
    [fail, goal]
  );

  /* ---------------- 子 Agent / 预设 / 导出 ---------------- */

  /**
   * Read a child's transcript.
   *
   * The child is a session of its own, so its events fold exactly like the main
   * one — through a throwaway `Timeline`, because the open session's fold must
   * not see another session's seq numbers.
   */
  const loadSubagentHistory = useCallback(
    async (childId: string, mode: SubagentEntry["mode"]) => {
      const id = sessionRef.current;
      if (!id) return [];
      const page = await call<HistoryPage>("subagent.history", {
        parentSessionId: id,
        childSessionId: childId,
        mode,
        maxMessages: 200,
      });
      const fold = new Timeline();
      for (const entry of page.events) fold.apply(entry.event);
      return fold.snapshot();
    },
    []
  );

  /** Only a continuable child can be interrupted; a one-shot ends with its own turn. */
  const interruptSubagent = useCallback(
    (childId: string) => {
      const id = sessionRef.current;
      if (!id) return;
      call("subagent.interrupt", {
        parentSessionId: id,
        childSessionId: childId,
        mode: "continuable",
      })
        .then(() => refreshSubagents())
        .catch(fail);
    },
    [fail, refreshSubagents]
  );

  const selectPreset = useCallback(
    (presetId: string) => {
      const id = sessionRef.current;
      if (!id) return;
      call<{ agentPreset: string }>("agentPreset.select", { sessionId: id, agentPreset: presetId })
        .then(({ agentPreset }) => {
          if (sessionRef.current !== id) return;
          setCurrentPreset(agentPreset);
          presetOf.current.set(id, agentPreset);
          /* The preset carries its own instructions and tool set, so the command
             list and the route can both be different afterwards. */
          refreshCapabilities(id);
        })
        .catch((error) => {
          /* The runtime pins a session's preset the moment it starts, and says so
             in English. The panel already disables the button — this catches the
             race where the turn lands between render and click. */
          if (error instanceof DshError && error.code === "agent-preset-locked") {
            notify("这个会话已经开始了，模式定死了。开个新会话再选。", "error");
            return;
          }
          fail(error);
        });
    },
    [fail, notify, refreshCapabilities]
  );

  /**
   * Change what the NEXT session starts from.
   *
   * `agentPreset.select` only answers on a blank session, so in anything with
   * history it is the wrong verb entirely — the default lives in settings, is
   * read per call, and leaves every running session on the preset it was
   * composed from. dsh's own preset UI draws the same two buttons.
   */
  const setDefaultPreset = useCallback(
    (presetId: string) => {
      void (async () => {
        try {
          if (!(await writeSettings(AGENT_PRESET_NS, [
            { op: "set", path: [AGENT_PRESET_DEFAULT_KEY], value: presetId },
          ]))) {
            notify("这个运行时没开放默认模式设置", "error");
            return;
          }
          const id = sessionRef.current;
          if (id) refreshCapabilities(id);
        } catch (error) {
          fail(error);
        }
      })();
    },
    [fail, notify, refreshCapabilities, writeSettings]
  );

  /** Read one preset's source file — the panel shows it instead of guessing what a mode does. */
  const readPreset = useCallback(async (presetId: string) => {
    const { content } = await call<{ content: string }>("agentPreset.read", {
      agentPreset: presetId,
    });
    return content;
  }, []);

  /** `openDocument` may decline to launch an editor; then it hands back the path instead. */
  const openPresetDocument = useCallback(
    (presetId: string) => {
      call<{ opened: boolean; path?: string }>("agentPreset.openDocument", {
        agentPreset: presetId,
      })
        .then((result) => {
          if (!result.opened && result.path) notify(`模式文件在 ${result.path}`, "info");
        })
        .catch(fail);
    },
    [fail, notify]
  );

  /* Copy is the only way to author one: the four built-ins are read-only, so a
     custom Agent starts as a copy and continues in the editor. */
  const copyPreset = useCallback(
    (from: string) => {
      ask({
        id: "copy-preset",
        dialogType: "input",
        title: "复制模式",
        message: "新模式的名字，会当作文件名，用英文和短横线。",
        placeholder: "my-preset",
        prefill: `${from}-copy`,
      })
        .then((result) => {
          const target = result && "value" in result ? result.value.trim() : "";
          if (target === "") return;
          return call<{ agentPreset: string }>("agentPreset.copy", { from, agentPreset: target })
            .then(({ agentPreset }) => {
              const id = sessionRef.current;
              if (id) refreshCapabilities(id);
              openPresetDocument(agentPreset);
            });
        })
        .catch(fail);
    },
    [ask, fail, openPresetDocument, refreshCapabilities]
  );

  const removePreset = useCallback(
    (presetId: string) => {
      ask({
        id: "remove-preset",
        dialogType: "confirm",
        title: "删除模式",
        message: "模式文件会从磁盘上删掉，用着它的会话会回到默认模式。",
      })
        .then((result) => {
          if (!result || !("confirmed" in result) || !result.confirmed) return;
          return call("agentPreset.remove", { agentPreset: presetId }).then(() => {
            const id = sessionRef.current;
            if (id) refreshCapabilities(id);
          });
        })
        .catch(fail);
    },
    [ask, fail, refreshCapabilities]
  );

  /** Follow up a continuable subagent — it keeps its own thread, so this is not a parent prompt. */
  const promptSubagent = useCallback(
    async (childSessionId: string, text: string) => {
      const id = sessionRef.current;
      if (!id || text.trim() === "") return false;
      try {
        await call("subagent.prompt", {
          parentSessionId: id,
          childSessionId,
          mode: "continuable",
          content: [{ type: "text", text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    [fail]
  );

  const exportSession = useCallback(() => {
    const id = sessionRef.current;
    if (!id) return;
    exportSessionLog(id)
      .then((path) => notify(`会话已导出到 ${path}`, "success"))
      .catch(fail);
  }, [fail, notify]);

  /**
   * Route the session.
   *
   * `session.selectModel` takes the whole route at once, so switching a model
   * carries an effort with it: the one in force when the adapter still offers
   * it, otherwise that model's own default.
   */
  const selectRoute = useCallback(
    (provider: string, model: string, reasoningEffort?: string) => {
      const id = sessionRef.current;
      if (!id) return;
      call("session.selectModel", { sessionId: id, provider, model, reasoningEffort })
        .then(() => {
          if (sessionRef.current !== id) return;
          refreshCapabilities(id);
        })
        .catch(fail);
      /* The picker is sticky: the same route becomes what the next session
         opens on. Best effort — the live session already moved. */
      void writeSettings(AGENT_MODEL_NS, [
        { op: "set", path: ["provider"], value: provider },
        { op: "set", path: ["model"], value: model },
        ...(reasoningEffort === undefined
          ? []
          : [{ op: "set" as const, path: ["reasoningEffort"], value: reasoningEffort }]),
      ]).catch(() => {});
    },
    [fail, refreshCapabilities, writeSettings]
  );

  const setModel = useCallback(
    (routeId: string) => {
      if (!models) return;
      /* `<providerId>/<modelId>`, and a model id may itself contain a slash. */
      const cut = routeId.indexOf("/");
      if (cut < 0) return;
      const providerId = routeId.slice(0, cut);
      const modelId = routeId.slice(cut + 1);
      const group = models.groups.find((item) => item.id === providerId);
      const entry = group?.models.find((item) => item.id === modelId);
      if (!group || !entry) return;
      const efforts = entry.reasoning?.efforts ?? [];
      const current = models.current?.reasoningEffort;
      const keep = current && efforts.some((effort) => effort.id === current);
      selectRoute(group.id, entry.id, keep ? current : entry.reasoning?.defaultEffort);
    },
    [models, selectRoute]
  );

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      const current = models?.current;
      if (!current) return;
      selectRoute(current.provider, current.model, level);
    },
    [models, selectRoute]
  );

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  /* Hydrate the shell's own preferences once, before the first paint settles. */
  useEffect(() => {
    const size = readFontSize();
    setUiFontSizeState(size);
    applyFontSize(size);
    setStartDirState(readStartDir());
    const notify = readNotifyOnIdle();
    setNotifyOnIdleState(notify);
    notifyRef.current = notify;
  }, []);

  const setUiFontSize = useCallback((size: number) => {
    setUiFontSizeState(size);
    writeFontSize(size);
    applyFontSize(size);
  }, []);

  const setNotifyOnIdle = useCallback((on: boolean) => {
    setNotifyOnIdleState(on);
    notifyRef.current = on;
    writeNotifyOnIdle(on);
  }, []);

  /**
   * Where 新建会话 opens.
   *
   * Empty means "wherever the runtime process sits" — which is the user's home,
   * because dsh.rs sets the child's cwd explicitly. Picking a folder here only
   * changes the starting point; a session already open keeps its own.
   */
  const setStartDir = useCallback((path: string) => {
    setStartDirState(path);
    writeStartDir(path);
  }, []);

  const pickStartDir = useCallback(() => {
    pickDirectory()
      .then((path) => {
        if (path) setStartDir(path);
      })
      .catch(() => {});
  }, [setStartDir]);

  /** Repaint and remember, without writing back. */
  const syncTheme = useCallback((preference: ThemePreference) => {
    setThemeState(preference);
    applyThemePreference(preference, setResolvedTheme);
  }, []);

  const setThemePreference = useCallback(
    (preference: ThemePreference) => {
      syncTheme(preference);
      /* Optimistic: the window is already repainted, so a failed write costs the
         persistence, not the interaction. One retry covers a stale revision —
         the settings panel writing the same namespace is the only other writer. */
      void (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            if (themeRevision.current === null) {
              const snapshot = await call<SettingsSnapshot>("settings.describe", {});
              themeRevision.current =
                snapshot.namespaces.find((view) => view.ns === THEME_NS)?.revision ?? 0;
            }
            const view = await call<SettingsNamespaceView>("settings.mutate", {
              ns: THEME_NS,
              ops: [{ op: "set", path: [THEME_KEY], value: preference }],
              expectedRevision: themeRevision.current,
            });
            themeRevision.current = view.revision;
            return;
          } catch (error) {
            themeRevision.current = null;
            if (attempt === 1) fail(error);
          }
        }
      })();
    },
    [fail, syncTheme]
  );

  const describeSettings = useCallback(() => call<SettingsSnapshot>("settings.describe", {}), []);

  /**
   * Path-addressed writes for every edit, including resets.
   *
   * `update` merges and `replace` overwrites wholesale — both would need the
   * client to re-send secrets it was never given. `mutate` names the one field
   * it means, so nothing else in the section can be lost.
   */
  const mutateSettings = useCallback(
    (ns: string, ops: SettingsPathOp[], expectedRevision: number) =>
      call<SettingsNamespaceView>("settings.mutate", { ns, ops, expectedRevision }),
    []
  );

  const openSettingsDocument = useCallback(() => {
    call("settings.openDocument", {}).catch(fail);
  }, [fail]);

  /**
   * Cross-session usage, folded out of one `session.list`.
   *
   * The list already carries each session's `tokenUsage` and `sessionStats`
   * projections, so this needs no per-session round trip and no reading of the
   * zstd session logs. What it cannot do is split a session across days: the
   * projection is a running total, so the whole of it lands on the day the
   * session was last touched.
   */
  const describeUsage = useCallback(async (): Promise<UsageHistory> => {
    const { items } = await call<{ items: SessionSummary[] }>("session.list");
    const days = new Map<string, UsageDay>();
    const noTokens = (): UsageTokens => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const totals = {
      sessions: 0,
      ...noTokens(),
      turns: 0,
      steps: 0,
      peak: noTokens(),
      offPeak: noTokens(),
    };
    let unmeasured = 0;

    for (const item of items) {
      if (archivedRef.current.has(item.sessionId)) continue;
      const values = item.projections?.values as
        | { tokenUsage?: Record<string, number>; sessionStats?: Record<string, number> }
        | undefined;
      const usage = values?.tokenUsage;
      totals.sessions += 1;
      if (!usage) {
        unmeasured += 1;
        continue;
      }

      const input = usage.uncachedInputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      /* Same approximation as the day bucket, one digit finer: the running total
         is filed under the band the session was last active in. */
      const band = bandAt(new Date(item.updatedAt));
      const bill = (into: UsageTokens) => {
        into.inputTokens += input;
        into.outputTokens += output;
        into.cacheReadTokens += cacheRead;
        into.cacheWriteTokens += cacheWrite;
      };
      bill(totals);
      bill(totals[band]);
      totals.turns += values?.sessionStats?.turns ?? 0;
      totals.steps += values?.sessionStats?.steps ?? 0;

      const date = localDate(item.updatedAt);
      const day =
        days.get(date) ??
        { date, sessions: 0, ...noTokens(), peak: noTokens(), offPeak: noTokens() };
      day.sessions += 1;
      bill(day);
      bill(day[band]);
      days.set(date, day);
    }

    return {
      days: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
      totals,
      unmeasured,
    };
  }, []);

  /**
   * The profile's plugins, joined with what the running process actually loaded.
   *
   * Two sources because they answer different questions: the profile manifest
   * says what is installed, `pluginInventory/list` says what is live. A plugin
   * installed a moment ago is in the first and not yet in the second.
   */
  const refreshPlugins = useCallback(() => {
    void (async () => {
      try {
        const installed = await pluginList();
        const inventory = await call<{ entries: { moduleName: string; enabled: boolean }[] }>(
          PLUGIN_INVENTORY,
          { args: {} }
        ).catch(() => ({ entries: [] }));
        const live = new Set(
          inventory.entries.filter((entry) => entry.enabled).map((entry) => entry.moduleName)
        );
        setPlugins(
          installed.map((entry) => ({ ...entry, running: live.has(entry.name) }))
        );
      } catch (error) {
        fail(error);
      }
    })();
  }, [fail]);

  const installPlugin = useCallback(
    async (spec: string) => {
      setPluginsBusy(true);
      try {
        await pluginAdd(spec);
        notify(`已安装 ${spec}，重启后生效`, "success");
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        setPluginsBusy(false);
        refreshPlugins();
      }
    },
    [fail, notify, refreshPlugins]
  );

  const removePlugin = useCallback(
    async (name: string) => {
      setPluginsBusy(true);
      try {
        await pluginRemove(name);
        notify(`已卸载 ${name}，重启后生效`, "success");
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        setPluginsBusy(false);
        refreshPlugins();
      }
    },
    [fail, notify, refreshPlugins]
  );

  /**
   * Restart, then reload the page.
   *
   * The layer stack is read once at boot, so a new plugin needs a new process.
   * Reloading afterwards is the honest way to resync: every session is detached
   * by the restart and both downlinks belong to the retired generation.
   */
  const restartRuntime = useCallback(() => {
    setPluginsBusy(true);
    restartRuntimeProcess()
      .then(() => window.location.reload())
      .catch((error: unknown) => {
        setPluginsBusy(false);
        fail(error);
      });
  }, [fail]);

  const closePreview = useCallback(() => setPreview(null), []);

  const activatePreview = useCallback((path: string) => {
    setPreview((state) => (state ? { ...state, activePath: path } : state));
  }, []);

  const closePreviewFile = useCallback((path: string) => {
    setPreview((state) => {
      if (!state) return state;
      const files = state.files.filter((file) => file.path !== path);
      if (files.length === 0) return null;
      const activePath = files.some((file) => file.path === state.activePath)
        ? state.activePath
        : files[0].path;
      return { files, activePath };
    });
  }, []);

  /**
   * Read one path lifted out of model output.
   *
   * `roots` is a fence, not a hint — the Rust side only reads a file that
   * canonicalizes inside one of them, because the path itself is untrusted.
   * A relative path is also tried against the directories the same message
   * mentioned: a tool call anchored at `src/kernel/` makes a bare `types.ts`
   * in the prose next to it mean that file.
   */
  const loadPreviewFile = useCallback(
    async (path: string, anchorDirs: string[] = []): Promise<PreviewFile> => {
      const sessionCwd = cwdOf.current.get(sessionRef.current ?? "") ?? host?.cwd ?? "";
      const home = sessionCwd.match(/^\/Users\/[^/]+/)?.[0];
      const roots = [
        ...new Set(
          [sessionCwd, home, ...workspacesRef.current.map((space) => space.path)].filter(
            (item): item is string => Boolean(item)
          )
        ),
      ];
      const targets =
        path.startsWith("/") || path.startsWith("~")
          ? [path]
          : [path, ...anchorDirs.map((dir) => `${dir}/${path}`)];
      let failure: unknown = new Error(`找不到 ${path}`);
      for (const target of targets) {
        try {
          const content = await readPreviewFile(roots, target);
          /* Keyed by what the user clicked, so the tab matches the link. */
          return { path, language: languageForPath(path), content };
        } catch (error) {
          failure = error;
        }
      }
      throw failure;
    },
    [host]
  );

  const openPreview = useCallback(
    (path: string, anchorDirs: string[] = []) => {
      void loadPreviewFile(path, anchorDirs)
        .then((file) => {
          setPreview((state) => {
            if (!state) return { files: [file], activePath: path };
            const files = state.files.some((item) => item.path === path)
              ? state.files.map((item) => (item.path === path ? file : item))
              : [...state.files, file];
            return { files, activePath: path };
          });
        })
        .catch(fail);
    },
    [fail, loadPreviewFile]
  );

  /** Every file this session has touched, newest last — what ⌘P falls back to. */
  const timelineFiles = useMemo(() => {
    const paths: string[] = [];
    const seen = new Set<string>();
    const add = (path: string | null) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      paths.push(path);
    };
    for (const message of messages) {
      for (const chunk of message.chunks) {
        if (chunk.type !== "tool_call") continue;
        const raw = (chunk.args as Record<string, unknown> | undefined)?.path;
        if (typeof raw === "string") add(previewPathFromText(raw));
      }
      for (const path of previewPathsFromText(message.content)) add(path);
    }
    return paths;
  }, [messages]);

  const togglePreview = useCallback(() => {
    if (preview) {
      setPreview(null);
      return;
    }
    void (async () => {
      /* Newest first: the file just written is the one worth looking at. */
      const candidates = timelineFiles.length ? [...timelineFiles].reverse() : ["README.md"];
      for (const path of candidates) {
        try {
          const file = await loadPreviewFile(path);
          setPreview({ files: [file], activePath: file.path });
          return;
        } catch {
          /* Sessions outlive the files they mention; keep looking. */
        }
      }
      notify("这个会话里没有还能打开的文件", "info");
    })();
  }, [loadPreviewFile, notify, preview, timelineFiles]);

  const pinnedProjects = useMemo(() => workspaces.map((space) => space.path), [workspaces]);

  /**
   * Flattened catalogue keyed by route, not by model.
   *
   * A plugin may mirror the whole DeepSeek group under a second provider — the
   * vision router registers `deepseek-vision` carrying the same two models — so
   * the bare model id is ambiguous and picking by it would always land on
   * whichever group happens to come first.
   */
  const availableModels = useMemo<ModelInfo[]>(
    () =>
      (models?.groups ?? []).flatMap((group) =>
        group.models.map<ModelInfo>((entry) => ({
          id: `${group.id}/${entry.id}`,
          name: entry.name,
          provider: group.name,
          description: entry.description,
        }))
      ),
    [models]
  );

  /* Reasoning efforts belong to the model, not to the app: DeepSeek offers
     off/high/max, and another route may offer something else entirely. */
  const availableThinkingLevels = useMemo<ThinkingOption[]>(() => {
    const route = models?.current;
    if (!route) return [];
    const entry = models?.groups
      .find((group) => group.id === route.provider)
      ?.models.find((item) => item.id === route.model);
    return entry?.reasoning?.efforts ?? [];
  }, [models]);

  const contextUsage = useMemo(() => readContextUsage(projections), [projections]);

  return useMemo<Kernel>(
    () => ({
      bootError,
      connection,
      sessionId,
      cwd: host?.cwd ?? "",
      sessions,
      /* Route key, matching `availableModels[].id` — see ModelInfo. */
      currentModel: models?.current
        ? `${models.current.provider}/${models.current.model}`
        : (host?.model ?? ""),
      availableModels,
      thinkingLevel: models?.current?.reasoningEffort ?? "",
      availableThinkingLevels,
      skills,
      commands,
      contextUsage,
      plan,
      goal,
      todos,
      permission,
      subagents,
      jobs,
      agentPresets,
      presetsAuthorable,
      currentPreset,
      /* dsh pins the preset at the session's first turn (`sessionBlank` in
         agentPreset.select), so anything with history can no longer switch. */
      presetLocked: messages.length > 0,
      imageLimits,
      isStreaming,
      isCompacting: false,
      messages,
      queue,
      hasMoreHistory,
      isLoadingHistory,
      searchHits,
      dialogRequest,
      notification,
      preview,
      settingsOpen,
      runtimeVersion: version,
      apiKeyConfigured,
      apiKeyPrompt,
      themePreference,
      theme,

      prompt,
      abort,
      notify,
      compact,
      setModel,
      setThinkingLevel,
      openSession,
      newSession,
      forkSession,
      loadMoreHistory,
      removeQueued,
      searchSessions,
      resolveDialog,
      refreshSessions,
      /* dsh has no "forget this session" — a fresh session is the honest
         equivalent, and the old log stays where the runtime put it. */
      clearTimeline: newSession,
      openPreview,
      closePreview,
      togglePreview,
      activatePreview,
      closePreviewFile,
      pinnedProjects,
      addProject,
      pinProject,
      newSessionInProject,
      bindProject,
      renameSession,
      deleteSession,
      deleteProject,
      executeCommand,
      togglePlanMode,
      setGoal,
      updateGoal,
      setPermission,
      refreshSubagents,
      loadSubagentHistory,
      interruptSubagent,
      selectPreset,
      setDefaultPreset,
      uiFontSize,
      setUiFontSize,
      startDir,
      setStartDir,
      pickStartDir,
      notifyOnIdle,
      setNotifyOnIdle,
      readPreset,
      copyPreset,
      openPresetDocument,
      removePreset,
      promptSubagent,
      exportSession,
      loadAttachment,

      openSettings,
      closeSettings,
      describeSettings,
      mutateSettings,
      openSettingsDocument,
      describeUsage,
      setApiKey,
      saveApiKey,
      dismissApiKeyPrompt,
      setThemePreference,
      syncTheme,
      plugins,
      pluginsBusy,
      refreshPlugins,
      installPlugin,
      removePlugin,
      restartRuntime,
    }),
    [
      abort,
      activatePreview,
      addProject,
      apiKeyConfigured,
      apiKeyPrompt,
      availableModels,
      availableThinkingLevels,
      bindProject,
      closePreview,
      closePreviewFile,
      closeSettings,
      bootError,
      commands,
      compact,
      connection,
      contextUsage,
      agentPresets,
      presetsAuthorable,
      currentPreset,
      deleteProject,
      deleteSession,
      describeSettings,
      dialogRequest,
      executeCommand,
      exportSession,
      goal,
      imageLimits,
      interruptSubagent,
      jobs,
      loadAttachment,
      loadSubagentHistory,
      permission,
      plan,
      refreshSubagents,
      selectPreset,
      setDefaultPreset,
      uiFontSize,
      setUiFontSize,
      startDir,
      setStartDir,
      pickStartDir,
      notifyOnIdle,
      setNotifyOnIdle,
      readPreset,
      copyPreset,
      openPresetDocument,
      removePreset,
      promptSubagent,
      setGoal,
      setPermission,
      subagents,
      todos,
      togglePlanMode,
      updateGoal,
      forkSession,
      hasMoreHistory,
      host,
      isLoadingHistory,
      isStreaming,
      loadMoreHistory,
      messages,
      models,
      mutateSettings,
      newSession,
      newSessionInProject,
      notification,
      notify,
      openSession,
      openSettings,
      openSettingsDocument,
      describeUsage,
      openPreview,
      togglePreview,
      installPlugin,
      pinProject,
      pinnedProjects,
      pluginsBusy,
      plugins,
      preview,
      prompt,
      queue,
      refreshPlugins,
      refreshSessions,
      removePlugin,
      removeQueued,
      renameSession,
      resolveDialog,
      restartRuntime,
      searchHits,
      searchSessions,
      sessionId,
      sessions,
      setApiKey,
      saveApiKey,
      dismissApiKeyPrompt,
      setModel,
      setThemePreference,
      setThinkingLevel,
      settingsOpen,
      skills,
      syncTheme,
      theme,
      themePreference,
    ]
  );
}
