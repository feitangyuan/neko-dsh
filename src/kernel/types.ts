/**
 * DSH GUI — 前端与内置 dsh 运行时之间的稳定接口。
 *
 * 形状沿用 pi-gui 的 Kernel（组件层不动），语义换成 dsh 的 /api 契约：
 * 会话句柄是 sessionId（不是 jsonl 路径），全部操作都走 POST /api/<method>。
 */

export type Role = "user" | "assistant" | "system" | "compaction";

export interface TimelineMessage {
  id: string;
  role: Role;
  content: string; // 纯文本汇总
  chunks: MessageContentChunk[]; // 权威结构，按顺序渲染
  timestamp: number;
  isStreaming?: boolean;
}

export type MessageContentChunk =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; isStreaming?: boolean }
  /** 图片只留引用，字节要用 `loadAttachment` 单独取 */
  | {
      type: "image";
      attachmentId: string;
      mediaType: string;
      width: number;
      height: number;
      name?: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: any;
      status: "running" | "completed" | "error";
      result?: any;
      partialResult?: any;
      startTime?: number;
      endTime?: number;
    };

export interface SessionMeta {
  id: string; // dsh sessionId，所有 session.* 方法的句柄
  title: string;
  cwd: string;
  updatedAt: number;
  messageCount: number;
}

export interface ModelInfo {
  /**
   * Route key `<providerId>/<modelId>`, not the bare model id.
   *
   * One model can appear under several providers — a vision plugin registers a
   * second `deepseek-vision` group carrying the same two DeepSeek models — and
   * the bare id cannot say which of them the user picked.
   */
  id: string;
  name: string;
  /** Provider group name, e.g. `DeepSeek` or `DeepSeek + 自动识图`. */
  provider: string;
  description?: string;
}

/**
 * Reasoning effort id. Adapter-owned and opaque: DeepSeek advertises
 * off / high / max today, another route may advertise anything else, so the set
 * comes from `session.models` rather than from a union declared here.
 */
export type ThinkingLevel = string;

export interface ThinkingOption {
  id: ThinkingLevel;
  name: string;
  description?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface CommandInfo {
  name: string; // 斜杠命令名（不含 /），派发走 commands/execute
  description: string;
  hint?: string; // 参数提示，例如 `<text>`；没有就是不带参数的命令
}

/**
 * 全部字段来自 host 的 session projection，前端不自己数 token。
 * 上游没有价格表，所以没有「成本」这一项——别再加回来。
 */
export interface ContextUsage {
  tokens: number; // 下一次请求的 prompt 预估占用（contextPressure）
  contextWindow: number;
  percent: number; // 0–100
  inputTokens: number; // 累计未命中缓存的输入
  outputTokens: number; // 累计输出
  cacheReadTokens: number; // 累计输入中命中缓存的部分
  cacheWriteTokens: number; // 累计写入缓存的输入
  systemTokens: number; // 上下文构成：系统提示（启发式估算）
  toolsTokens: number; // 上下文构成：工具 schema
  messageTokens: number; // 上下文构成：对话本身
  turns: number; // 累计轮数
  steps: number; // 累计 Agent 执行步数
  ttftMs: number; // 平均首 token 延迟
  tokensPerSecond: number; // 平均解码速率
}

/**
 * 会话的「当前状态」四件套，全部来自 session projection。
 *
 * 这四个 key 在 `session.history` 的 projections 基线里就有，之后走
 * `session/projection` 帧增量——和 token 表是同一条路，不用自己折叠事件。
 */

/** 计划模式：模型先给方案、不动手。`pending` = 这一轮结束时会退出 */
export interface PlanState {
  active: boolean;
  pending: boolean;
}

/** 长任务目标。dsh 会按轮数推进它，直到完成或者用完轮数 */
export interface GoalState {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason?: string; // 只有 blocked 时有
  maxGoalRounds: number;
  roundsStarted: number;
}

/** 模型自己维护的待办清单（`todo_write` 工具），每轮开始清空 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 权限档：越过这条线要弹框问人。档名一律用 dsh 官方显示名，不翻译 */
export interface PermissionState {
  current: string;
  /** 当前档的显示名，`current` 落在选项外（dsh 派生的 `custom`）时也有值 */
  currentName: string;
  options: { value: string; name: string }[];
}

/** 一个子 Agent。dsh 允许模型把活派给子会话，这是它们的列表项 */
export interface SubagentEntry {
  id: string;
  mode: "one-shot" | "continuable";
  activity: "running" | "inactive";
  label: string;
  hasChildren: boolean;
}

/** 后台任务（`session/jobs` 帧）。跟着会话跑，但不占对话轮次 */
export interface JobEntry {
  id: string;
  kind: string;
  label: string;
  status: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

/** 图片附件的上限，运行时给的（`imageLimits` projection） */
export interface ImageLimits {
  maxImageBytes: number;
  maxImagesPerMessage: number;
  maxMessageImageBytes: number;
  maxImagePixels: number;
  mediaTypes: string[];
}

/** 待发送的图片：base64 原始字节，发出去之后才变成 attachment */
export interface PromptImage {
  mediaType: string;
  data: string; // base64，不带 data: 前缀
  name?: string;
}

/** Agent 预设：一套指令 + 工具 + 模型的组合，按会话选 */
export interface AgentPreset {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  broken: string; // 坏掉的原因，空串 = 正常
  trust: "system" | "user"; // system = dsh 自带，只读；user = 自己写的，能改能删
}

/** schemastery 序列化 schema：一张按 uid 编号的节点表 */
export interface SchemaNode {
  type: string;
  meta?: {
    default?: unknown;
    required?: boolean;
    min?: number;
    max?: number;
    step?: number;
    role?: string;
  };
  dict?: Record<string, number>;
  list?: number[];
  inner?: number;
  value?: unknown;
}

export interface SchemaJSON {
  uid: number;
  refs: Record<string, SchemaNode>;
}

/** 只写字段（API key 之类）：值永远不下行，只报告有没有设过 */
export interface SettingsSecretSlot {
  path: string[];
  set: boolean;
}

export interface SettingsNamespaceView {
  ns: string;
  schema: SchemaJSON;
  value: Record<string, unknown>; // 已脱敏的生效值
  base?: Record<string, unknown>; // 组合层默认值
  user?: Record<string, unknown>; // 用户层，出现在这里 = 被改过
  applies: "live" | "restart";
  secrets: SettingsSecretSlot[];
  revision: number; // 写回时带上，防止覆盖并发修改
}

export interface SettingsSnapshot {
  writable: boolean;
  hasDocument: boolean;
  namespaces: SettingsNamespaceView[];
}

export type SettingsPathOp =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "unset"; path: string[] };

export type ThemePreference = "light" | "dark" | "system";

/**
 * 一个 profile 插件。
 *
 * 前三个字段来自 profile 的 package.json（Rust 侧读），`running` 来自运行时的
 * `pluginInventory/list`——装上了不等于加载了，两者要分开显示。
 */
export interface PluginEntry {
  name: string; // npm 包名
  version: string;
  description: string;
  active: boolean; // 在 profile 的层叠列表里
  removable: boolean; // 用户装的（内置组合不能删）
  running: boolean; // 当前这个运行时进程真的加载了它
}

/** 一档 token 计数。定价按这四项分开算，所以分时段统计也得分开存。 */
export interface UsageTokens {
  inputTokens: number; // 未命中缓存的输入
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 一天的用量。日期是本地时区的 `YYYY-MM-DD`。
 *
 * `peak` / `offPeak` 是同一批 token 按**北京时间的高峰／空闲时段**再拆一次，两份相加
 * 等于外层的合计。归档口径和日期一样：整个会话记在它**最后活动**那一刻所在的档位，
 * 因为运行时的 projection 只有累计值，没有逐轮的时间戳。
 */
export interface UsageDay extends UsageTokens {
  date: string;
  sessions: number;
  peak: UsageTokens;
  offPeak: UsageTokens;
}

/**
 * 跨会话用量。
 *
 * 数据来自 `session.list` 里每个会话的 `tokenUsage` projection——运行时自己算好的，
 * 前端不重算。⚠️ 归集口径：一个会话的全部用量记在它**最后活动**的那天、那个时段，
 * 因为 projection 只有累计值，没有按天按轮的明细。
 */
export interface UsageHistory {
  days: UsageDay[]; // 按日期升序
  totals: UsageTokens & {
    sessions: number;
    turns: number;
    steps: number;
    peak: UsageTokens;
    offPeak: UsageTokens;
  };
  /** 运行时还没给出用量的会话数（刚建的、或者投影还没落盘） */
  unmeasured: number;
}

export type StreamingBehavior = "steer" | "followUp";

/** 已提交但还没轮到执行的输入。dsh 在 turn 之间派发队列，队列本身随时可改 */
export interface QueuedPrompt {
  id: string;
  placement: "queued" | "steering" | "context";
  text: string;
}

/** 会话全文搜索命中（snippet 由 host 截好，前端不再截） */
export interface SessionSearchHit {
  sessionId: string;
  snippet: string;
}

/** 预览面板目标：代码文件 / md 文档（md 走渲染视图，其余等宽源码视图） */
export interface PreviewFile {
  path: string;
  language?: string;
  content: string;
}

/** 预览面板状态：多文件 tab + 当前激活路径 */
export interface PreviewState {
  files: PreviewFile[];
  activePath: string;
}

/** provider 凭据状态（key 本体不进前端状态） */
export interface ProviderStatus {
  provider: string;
  configured: boolean;
}

export type SteeringMode = "one-at-a-time" | "all";
export type ProjectTrust = "ask" | "always" | "never";

export type DialogType = "select" | "confirm" | "input" | "editor";

export interface UIDialogOption {
  label: string;
  value: string;
  description?: string;
}

export interface UIDialogRequest {
  id: string;
  dialogType: DialogType;
  title: string;
  message?: string;
  detail?: string; // 等宽副文本：待授权的命令、计划正文
  options?: UIDialogOption[]; // select
  placeholder?: string; // input
  prefill?: string; // editor
  allowEmpty?: boolean; // input: empty submit is a valid value
  secret?: boolean; // input: mask sensitive values
  multiSelect?: boolean; // select: more than one option may be picked
  allowCustom?: boolean; // select: free-text "其他" answer alongside the options
  okLabel?: string;
  cancelLabel?: string;
}

export type DialogResult =
  | { value: string }
  | { values: string[]; custom?: string } // select
  | { confirmed: boolean }
  | null; // null = cancel

export type ConnectionState = "connected" | "connecting" | "error";

export interface Notification {
  text: string;
  kind: "info" | "success" | "error";
}

export interface Kernel {
  // ---- 状态 ----
  connection: ConnectionState;
  /**
   * 运行时没起来时的完整报告（含 dsh 自己的输出尾巴）。空串 = 没这回事。
   *
   * 一个加载失败的插件会把整棵树带崩，这时候用户需要看到原因，
   * 还需要一个不用开终端就能自救的出口。
   */
  bootError: string;
  sessionId: string;
  cwd: string;
  sessions: SessionMeta[];
  /** The active route as a `ModelInfo.id`, so it matches the picker's values. */
  currentModel: string;
  availableModels: ModelInfo[];
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingOption[];
  skills: SkillInfo[];
  commands: CommandInfo[];
  contextUsage: ContextUsage;
  /* ---- 会话现在处于什么状态（全部来自 projection，见上面四个接口）---- */
  plan: PlanState;
  goal: GoalState | null;
  todos: TodoItem[];
  permission: PermissionState;
  subagents: SubagentEntry[]; // 本会话派出去的子 Agent
  jobs: JobEntry[]; // 后台任务
  agentPresets: AgentPreset[];
  presetsAuthorable: boolean; // 运行时允许自建预设（可写目录 + 有文件可开）
  /** 会话一开跑，模式就锁死了（dsh 的 `sessionBlank` 闸），只能开新会话再选 */
  presetLocked: boolean;
  imageLimits: ImageLimits | null; // null = 运行时还没报上限
  currentPreset: string; // 当前会话选的预设 id，空串 = 默认
  isStreaming: boolean;
  isCompacting: boolean;
  messages: TimelineMessage[];
  queue: QueuedPrompt[]; // 排队中的输入，正在跑的那一轮不在内
  hasMoreHistory: boolean; // 当前会话上面还有更早的消息没拉
  isLoadingHistory: boolean;
  searchHits: SessionSearchHit[] | null; // null = 没有在搜；[] = 搜了没命中
  dialogRequest: UIDialogRequest | null;
  notification: Notification | null;
  preview: PreviewState | null; // null = 预览面板关闭
  settingsOpen: boolean;
  runtimeVersion: string; // dsh 版本，设置面板的「关于」用
  apiKeyConfigured: boolean;
  /** API key 输入框开着没有。只从设置面板打开，不会自己弹 */
  apiKeyPrompt: "none" | "open";
  /**
   * 主题。存在 dsh 的 `ui-theme` namespace 里，但消费它的是 dsh 自己的浏览器插件，
   * 我们没加载——所以壳自己读同一个值、自己刷 `data-theme`，全局只此一个 writer。
   */
  themePreference: ThemePreference;
  theme: "light" | "dark"; // themePreference 解析后的结果（system 走系统外观）

  // ---- 操作 ----
  /** 返回是否发出去了：运行时拒了（比如 Model 不吃图片）就是 false，输入井好把内容还回去 */
  prompt(text: string, streamingBehavior?: StreamingBehavior, images?: PromptImage[]): Promise<boolean>;
  abort(): void;
  notify(text: string, kind?: Notification["kind"]): void;
  compact(customInstructions?: string): void;
  setModel(modelId: string): void;
  setThinkingLevel(level: ThinkingLevel): void;
  openSession(sessionId: string): void;
  newSession(): void;
  forkSession(entryId?: string): void;
  loadMoreHistory(): void; // 往上翻一页
  removeQueued(itemId: string): void; // 撤掉一条还没执行的排队输入
  searchSessions(query: string): void; // 空串 = 退出搜索
  resolveDialog(id: string, result: DialogResult): void;
  refreshSessions(): void;
  clearTimeline(): void;
  openPreview(path: string, anchorDirs?: string[]): void;
  closePreview(): void;
  togglePreview(): void; // 无选定文件时预览最近涉及的文件
  activatePreview(path: string): void; // 切换激活 tab
  closePreviewFile(path: string): void; // 关掉单个 tab，最后一个关完即关面板
  /**
   * dsh workspace 的路径列表，顺序 = 运行时里的显示顺序。
   * pi-gui 时代这是 localStorage 里的置顶列表，现在由 workspace.list 提供。
   */
  pinnedProjects: string[];
  addProject(): void; // 选择文件夹、建 workspace，并在其中开始新 Session
  pinProject(cwd: string): void; // 把 workspace 挪到最前（dsh 没有「取消置顶」，顺序就是顺序）
  newSessionInProject(cwd: string): void; // 在项目下新建会话
  bindProject(cwd: string | null): void; // 会话 cwd 建后不可改，所以这是「在该目录新建会话」
  renameSession(sessionId: string): void; // 弹输入框重命名
  deleteSession(sessionId: string): void; // 弹确认框归档
  deleteProject(cwd: string): void; // 弹确认框删除 workspace
  executeCommand(name: string): void;

  // ---- 会话状态操作 ----
  /** 进出计划模式。没有 RPC，只有 `/plan` 命令这一条路 */
  togglePlanMode(): void;
  setGoal(objective: string): Promise<void>; // 新建目标（已有目标时是改写）
  /** 目标的生命周期动作，都走 `goal.*` RPC，带 ref 防并发覆盖 */
  updateGoal(action: "pause" | "resume" | "complete" | "clear"): void;
  setPermission(value: string): void; // 同样只有 `/permission <value>` 一条路
  /** 拉一次子 Agent 列表；父会话没有子 Agent 时返回空数组 */
  refreshSubagents(): void;
  /** 读一个子 Agent 的完整对话，用于展开查看 */
  loadSubagentHistory(childId: string, mode: SubagentEntry["mode"]): Promise<TimelineMessage[]>;
  interruptSubagent(childId: string): void;
  selectPreset(presetId: string): void; // 只有空会话能换，见 `presetLocked`
  setDefaultPreset(presetId: string): void; // 改的是「以后新会话从哪个模式开」

  /* 外壳自己的偏好（存在 localStorage，不是 dsh 设置，见 shellPrefs.ts） */
  uiFontSize: number;
  setUiFontSize(size: number): void;
  startDir: string; // 新会话从哪个目录开，空 = 运行时进程所在目录
  setStartDir(path: string): void;
  pickStartDir(): void;
  notifyOnIdle: boolean; // 窗口在后台时，一轮跑完弹跳 Dock 图标
  setNotifyOnIdle(on: boolean): void;
  readPreset(presetId: string): Promise<string>;
  copyPreset(from: string): void; // 弹输入框问新名字，复制完直接打开文件
  openPresetDocument(presetId: string): void;
  removePreset(presetId: string): void;
  /** 给可续的子 Agent 追一句话，走它自己的线程 */
  promptSubagent(childSessionId: string, text: string): Promise<boolean>; // 换 Agent 预设
  exportSession(): void; // 导出会话日志 ZIP，存到「下载」
  /** 取图片附件的字节，返回可直接塞进 `<img src>` 的 data URL */
  loadAttachment(attachmentId: string): Promise<string>;

  // ---- 设置 ----
  openSettings(): void;
  closeSettings(): void;
  /** 每次打开面板都重新读，schema 和 revision 都可能已经变了 */
  describeSettings(): Promise<SettingsSnapshot>;
  /** 路径寻址写回（set / unset 同一条路），返回该 namespace 的新视图 */
  mutateSettings(
    ns: string,
    ops: SettingsPathOp[],
    expectedRevision: number
  ): Promise<SettingsNamespaceView>;
  openSettingsDocument(): void; // 交给系统文本编辑器打开 settings 文档
  /** 跨会话用量。每次打开都重算，没有缓存——一次 `session.list` 就够 */
  describeUsage(): Promise<UsageHistory>;

  // ---- 插件 ----
  plugins: PluginEntry[];
  pluginsBusy: boolean; // 有一次安装/卸载在跑（pnpm 要几秒）
  refreshPlugins(): void;
  /** 装一个 npm 包（走 `dsh plugin add`，要联网）。resolve = 装好了，等重启生效 */
  installPlugin(spec: string): Promise<void>;
  removePlugin(name: string): Promise<void>;
  /** 重启运行时让层叠列表重新生效，随后整页重载以重开两条下行流 */
  restartRuntime(): void;

  setApiKey(): void; // 打开 API key 输入框
  /** 存进本机凭据服务。reject = 没存进去，框留在原地 */
  saveApiKey(value: string): Promise<void>;
  dismissApiKeyPrompt(): void;
  setThemePreference(preference: ThemePreference): void; // 立即生效并写回设置
  /** 设置面板改完主题后回灌：值已经写进去了，这里只负责重绘 */
  syncTheme(preference: ThemePreference): void;
}
