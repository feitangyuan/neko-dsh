import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../lib/runtime";
import { estimateCost, formatCNY } from "../kernel/pricing";
import type {
  CommandInfo,
  ContextUsage,
  ImageLimits,
  ModelInfo,
  Notification,
  PermissionState,
  PlanState,
  PromptImage,
  SkillInfo,
  ThinkingLevel,
  ThinkingOption,
} from "../kernel/types";
import { PopupMenu } from "./PopupMenu";

interface Props {
  isStreaming: boolean;
  disabled: boolean;
  commands: CommandInfo[];
  skills: SkillInfo[];
  models: ModelInfo[];
  currentModel: string;
  onModelChange: (id: string) => void;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingOption[];
  onThinkingLevel: (l: ThinkingLevel) => void;
  contextUsage: ContextUsage;
  plan: PlanState;
  onTogglePlan: () => void;
  permission: PermissionState;
  onPermission: (value: string) => void;
  cwd: string;
  pinnedProjects: string[];
  onBindProject: (project: string | null) => void;
  onChooseFolder: () => void;
  imageLimits: ImageLimits | null;
  onSend: (text: string, behavior?: "steer" | "followUp", images?: PromptImage[]) => Promise<boolean>;
  onAbort: () => void;
  onCommand: (name: string) => void;
  onNotify: (text: string, kind?: Notification["kind"]) => void;
}

/** 运行时没报上限之前的兜底，数值抄 dsh `LocalAttachmentStore` 的默认值 */
const FALLBACK_IMAGE_LIMITS: ImageLimits = {
  maxImageBytes: 5242880,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 104857600,
  maxImagePixels: 4e7,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`;
}

/** File → base64（去掉 data: 前缀），失败返回 null */
function readBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma < 0 ? null : result.slice(comma + 1));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 像素数上限是 dsh 自己的闸，本地先量一次省得白跑一轮 */
function readPixels(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.naturalWidth * img.naturalHeight);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0); // 量不出来就放行，交给运行时判
    };
    img.src = url;
  });
}

/** token 缩写：12400 → 12.4k */
function fmtTokens(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

const PROJECT_HOME = "__home__";
const PROJECT_CHOOSE = "__choose_folder__";

/** 路径最后一段作为项目名（与侧栏 projectName 同款） */
function baseName(p: string): string {
  const segs = p.replace(/\/+$/, "").split("/");
  return segs[segs.length - 1] || p;
}

/* 像素文件夹：经典台阶轮廓——签与盒身同为 1px 描边、共享顶边（字体无文件夹字形） */
const FolderIcon = (
  <span aria-hidden="true" className="relative block h-[11px] w-[12px] shrink-0">
    <span className="absolute left-0 top-0 block h-[3px] w-[5px] border border-b-0 border-current" />
    <span className="absolute bottom-0 left-0 block h-[8px] w-full border border-current" />
  </span>
);

interface SlashItem {
  kind: "command" | "skill";
  name: string;
  description: string;
  hint?: string; // 命令的参数提示，有参数的命令选中后先填进输入井
}

export function Composer({
  isStreaming,
  disabled,
  commands,
  skills,
  models,
  currentModel,
  onModelChange,
  thinkingLevel,
  thinkingLevels,
  onThinkingLevel,
  contextUsage,
  plan,
  onTogglePlan,
  permission,
  onPermission,
  cwd,
  pinnedProjects,
  onBindProject,
  onChooseFolder,
  imageLimits,
  onSend,
  onAbort,
  onCommand,
  onNotify,
}: Props) {
  const modelName = models.find((m) => m.id === currentModel)?.name ?? currentModel;

  /* One section per provider group. A plugin can mirror the whole catalogue
     under a second provider — the vision router's `DeepSeek + 自动识图` carries
     the same two models — and a flat list would then show two identical rows.
     A single group needs no header: it would only name what the trigger says. */
  const modelSections = useMemo(() => {
    const groups: { title: string; items: { value: string; label: string }[] }[] = [];
    for (const model of models) {
      const group = groups.find((item) => item.title === model.provider);
      const row = { value: model.id, label: model.name };
      if (group) group.items.push(row);
      else groups.push({ title: model.provider, items: [row] });
    }
    return groups.map((group) => ({
      ...(groups.length > 1 ? { title: group.title } : {}),
      items: group.items,
      activeValue: currentModel,
      onSelect: onModelChange,
    }));
  }, [models, currentModel, onModelChange]);

  /* 项目绑定弹层：与侧栏「项目」共享同一份 pinnedProjects；主目录 = dsh 默认目录 */
  const projectItems = useMemo(
    () => [
      { value: PROJECT_HOME, label: "主目录", description: "~" },
      ...pinnedProjects.map((p) => {
        const segs = p.replace(/\/+$/, "").split("/");
        return {
          value: p,
          label: baseName(p),
          description: segs.length > 1 ? `…/${segs.slice(-2, -1).join("/")}` : "",
        };
      }),
      { value: PROJECT_CHOOSE, label: "选择文件夹…" },
    ],
    [pinnedProjects],
  );
  const promptTokens =
    contextUsage.inputTokens + contextUsage.cacheReadTokens + contextUsage.cacheWriteTokens;
  const cachePct =
    promptTokens > 0
      ? Math.round((contextUsage.cacheReadTokens / promptTokens) * 100)
      : 0;
  const meterClass =
    contextUsage.percent > 80 ? "mac-meter-hot" : contextUsage.percent > 55 ? "mac-meter-warn" : "";
  /* 按高峰价显示：会话是跨时段的，没法知道哪些 token 落在空闲时段，
     所以这里给上界，两个端点都在 hover 里。 */
  const cost = estimateCost(contextUsage, currentModel);
  const [value, setValue] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  /* 斜杠菜单：输入 / 开头时弹出，数据全部来自 kernel */
  const slashItems: SlashItem[] | null = useMemo(() => {
    if (!value.startsWith("/") || value.includes("\n")) return null;
    const q = value.slice(1).toLowerCase();
    if (q.includes(" ")) return null;
    const cmds = commands
      .filter((c) => c.name.toLowerCase().includes(q))
      .map((c) => ({
        kind: "command" as const,
        name: c.name,
        description: c.description,
        hint: c.hint,
      }));
    const sks = skills
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((s) => ({ kind: "skill" as const, name: s.name, description: s.description }));
    const all = [...cmds, ...sks];
    return all.length > 0 ? all : null;
  }, [value, commands, skills]);

  useEffect(() => setSlashIndex(0), [value]);

  /* 自动长高 */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [value]);

  /* 文件拖放：OS 事件经 Rust 转发（tauri.conf 里 dragDropEnabled=false）。
     悬停 = Finder 式黑框高亮；落下把路径插入输入井（含空格的路径加引号）。 */
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void listen<{ kind: string; paths?: string[] }>("file-drag", (event) => {
      const { kind, paths } = event.payload;
      if (kind === "enter") {
        setDragOver(true);
      } else if (kind === "leave") {
        setDragOver(false);
      } else if (kind === "drop") {
        setDragOver(false);
        const text = (paths ?? []).map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
        if (text) {
          setValue((v) => (v.trim() ? `${v.trimEnd()} ${text} ` : `${text} `));
          taRef.current?.focus();
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /* 图片附件：粘贴进来先攒着，随下一条消息一起发。
     上限用运行时报的 imageLimits——超了这边就拦掉，省得发出去再被拒。 */
  const [images, setImages] = useState<PromptImage[]>([]);
  const limits = imageLimits ?? FALLBACK_IMAGE_LIMITS;
  const attachImages = async (files: File[]) => {
    const accepted: PromptImage[] = [];
    let total = images.reduce((sum, image) => sum + Math.ceil((image.data.length * 3) / 4), 0);
    for (const file of files) {
      if (!limits.mediaTypes.includes(file.type)) {
        onNotify(`不支持的图片格式：${file.type || "未知"}`, "error");
        continue;
      }
      if (images.length + accepted.length >= limits.maxImagesPerMessage) {
        onNotify(`一条消息最多 ${limits.maxImagesPerMessage} 张图`, "error");
        break;
      }
      if (file.size > limits.maxImageBytes) {
        onNotify(`图片超过 ${fmtBytes(limits.maxImageBytes)}`, "error");
        continue;
      }
      if (total + file.size > limits.maxMessageImageBytes) {
        onNotify(`一条消息的图片合计不能超过 ${fmtBytes(limits.maxMessageImageBytes)}`, "error");
        break;
      }
      const pixels = await readPixels(file);
      if (limits.maxImagePixels > 0 && pixels > limits.maxImagePixels) {
        onNotify("图片尺寸太大", "error");
        continue;
      }
      const data = await readBase64(file);
      if (!data) {
        onNotify("图片读不出来", "error");
        continue;
      }
      total += file.size;
      accepted.push({ mediaType: file.type, data, name: file.name || undefined });
    }
    if (accepted.length) setImages((list) => [...list, ...accepted]);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault(); // 有图就别再把剪贴板里的文件名当文本贴进来
    void attachImages(files);
  };

  const submit = (behavior?: "steer" | "followUp") => {
    const text = value.trim();
    if (!text && images.length === 0) return;
    /* 命令走 commands/execute：session.prompt 不认斜杠，发过去只会被模型当文本读。
       只认已注册的命令名——skill 也是 /name 起头，那种要原样交给模型。 */
    const head = text.slice(1).split(/\s/, 1)[0];
    if (text.startsWith("/") && commands.some((c) => c.name === head)) {
      onCommand(text.slice(1));
      setValue("");
      return;
    }
    if (isStreaming && !behavior) behavior = "followUp";
    const sentImages = images;
    setValue("");
    setImages([]);
    /* 运行时拒了就把内容还回输入井——只在用户没接着敲字的时候还，别覆盖新输入 */
    void onSend(text, behavior, sentImages).then((ok) => {
      if (ok) return;
      setValue((v) => v || text);
      setImages((list) => (list.length ? list : sentImages));
    });
  };

  const pickSlash = (item: SlashItem) => {
    if (item.kind === "command") {
      /* 带参数的命令先落进输入井，等用户把参数补完再发 */
      if (item.hint) {
        setValue(`/${item.name} `);
        taRef.current?.focus();
        return;
      }
      setValue("");
      onCommand(item.name);
    } else {
      setValue(`/${item.name} `);
      taRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // WebKit may report the IME confirmation Enter before React finishes composition.
    if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
      return;
    }
    if (slashItems) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation(); // 防止同一按键事件泄漏进新开的弹窗
        pickSlash(slashItems[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setValue("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        submit("steer");
      } else {
        submit();
      }
    }
  };

  return (
    <div className="shrink-0 bg-[var(--bg-surface)] px-5 pb-3.5 pt-1">
      <div className="relative mx-auto max-w-[820px]">
        {/* 斜杠菜单：Mac menu 风格（白面黑边反白选中） */}
        {slashItems && (
          <div className="absolute bottom-full left-0 z-30 mb-1.5 w-[360px] border border-[var(--ink)] bg-[var(--chrome-hi)] py-0.5 shadow-[var(--shadow-pop)]">
            {slashItems.map((item, i) => {
              const prev = slashItems[i - 1];
              const showHeader = item.kind !== prev?.kind;
              const active = i === slashIndex;
              return (
                <div key={`${item.kind}-${item.name}`}>
                  {showHeader && (
                    <div className="border-b border-[var(--chrome-lo)] px-2.5 py-0.5 font-mini text-[10px] tracking-wider text-[var(--ink-dim)]">
                      {item.kind === "command" ? "命令" : "Skill"}
                    </div>
                  )}
                  <button
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => pickSlash(item)}
                    className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-[12px] ${
                      active ? "bg-[var(--ink)] text-[var(--chrome-hi)]" : "text-[var(--ink)]"
                    }`}
                  >
                    <span className="shrink-0">/{item.name}</span>
                    <span className={`truncate font-mini text-[10px] ${active ? "text-[var(--chrome)]" : "text-[var(--ink-dim)]"}`}>
                      {item.description}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* 项目绑定：贴在输入井左上角，图标左缘与输入井左边线对齐（-ml 抵消 plain 按钮的 px-1.5） */}
        <div className="-ml-1.5 flex items-center pb-0.5">
          <PopupMenu
            plain
            up
            chevron={false}
            width={240}
            items={projectItems}
            activeValue={cwd}
            onSelect={(v) => {
              if (v === PROJECT_CHOOSE) onChooseFolder();
              else onBindProject(v === PROJECT_HOME ? null : v);
            }}
            trigger={<span className="flex items-center" title={`Project: ${cwd}`}>{FolderIcon}</span>}
          />
        </div>

        {/* 终端输入井：内凹刻感（经典 Mac 文本框） */}
        <div
          className={`flex border bg-[var(--bg-surface)] shadow-[inset_1px_1px_0_rgba(0,0,0,0.12)] ${
            dragOver
              ? "border-[var(--ink)] outline-2 outline-offset-2 outline-[var(--ink)]"
              : disabled
                ? "border-[var(--border-subtle)] opacity-60"
                : "border-[var(--border-main)] focus-within:border-[var(--accent)]/60"
          }`}
        >
        <div className="min-w-0 flex-1">
          {/* 待发送的图片：缩略图挂在输入井顶部，点 ✕ 撤掉 */}
          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
              {images.map((image, i) => (
                <span
                  key={i}
                  className="group/img relative block h-[34px] w-[34px] border border-[var(--border-main)]"
                  title={image.name ?? "图片"}
                >
                  <img
                    src={`data:${image.mediaType};base64,${image.data}`}
                    alt={image.name ?? "图片"}
                    className="h-full w-full object-cover"
                  />
                  <button
                    onClick={() => setImages((list) => list.filter((_, j) => j !== i))}
                    title="移除"
                    className="absolute -right-[5px] -top-[5px] flex h-[12px] w-[12px] items-center justify-center border border-[var(--border-main)] bg-[var(--bg-surface)] font-mini text-[9px] leading-none text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--error)] group-hover/img:opacity-100"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex">
            <span className="shrink-0 select-none pl-2.5 pr-1.5 pt-2.5 text-[12px] text-[var(--accent)]">
              ❯
            </span>
            <textarea
              ref={taRef}
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              placeholder={
                dragOver
                  ? "松手插入文件路径…"
                  : isStreaming
                    ? "生成中… 回车排队 · ⌘回车插话"
                    : "说点什么，或者按 / 调命令…"
              }
              className="block w-full resize-none bg-transparent pb-2 pl-0 pr-2.5 pt-2.5 text-[12px] leading-relaxed text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
            />
          </div>
            {/* 控制条：模型/思考档弹出菜单 + token 统计 + ctx 条纹进度条 + 发送。
                业界共识布局（Cursor/ChatWise/Cline/dsh CLI 均贴在输入框旁） */}
            <div className="flex items-center justify-between gap-3 px-2.5 pb-2">
              {/* 控件不许被挤掉，右边的统计文字才是可截断的那一半 */}
              <div className="flex shrink-0 items-center gap-1.5">
                {/* Model and thinking effort are one decision ("how hard does this
                    run think"), so they share one trigger instead of two. Only the
                    model is on the face of it: the effort is set once and then sits
                    there, and the menu already marks which one is active. */}
                <PopupMenu
                  trigger={<span className="block max-w-[190px] truncate">{modelName}</span>}
                  sections={[
                    ...modelSections,
                    ...(thinkingLevels.length > 1
                      ? [
                          {
                            title: "思考",
                            /* Efforts come from the adapter, so there is nothing
                               to translate here — the runtime names them. */
                            items: thinkingLevels.map((l) => ({ value: l.id, label: l.name })),
                            activeValue: thinkingLevel,
                            onSelect: (v: string) => onThinkingLevel(v as ThinkingLevel),
                          },
                        ]
                      : []),
                  ]}
                  width={190}
                  up
                  compact
                />
                {/* 权限档：越过这条线的工具调用会弹框问人。
                    没有 RPC，只有 `/permission <value>`，所以走命令通道 */}
                {permission.options.length > 0 && (
                  <PopupMenu
                    trigger={<>{permission.currentName}</>}
                    items={permission.options.map((option) => ({
                      value: option.value,
                      label: option.name,
                    }))}
                    activeValue={permission.current}
                    onSelect={onPermission}
                    width={170}
                    up
                    compact
                  />
                )}
                <button
                  onClick={onTogglePlan}
                  title={plan.active ? "退出计划模式" : "进入计划模式：先给方案，不动手"}
                  /* Same 20px box as the two popup chips beside it. */
                  className={`flex h-5 shrink-0 items-center whitespace-nowrap border px-1.5 font-mini text-[10px] leading-none ${
                    plan.active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]"
                      : "border-[var(--border-main)] text-[var(--text-dim)] hover:border-[var(--text-main)] hover:text-[var(--text-main)]"
                  }`}
                >
                  {/* pending = 这一轮跑完就退出，先把状态说出来再说 */}
                  计划{plan.pending ? "·退出中" : ""}
                </button>
              </div>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                {/* Running totals stay on the bar — the controls to the left were
                    what crowded this row, not these numbers. Hover has the rest. */}
                <span
                  className="min-w-0 truncate font-mini text-[10px] tabular-nums text-[var(--text-dim)]"
                  title={`本会话累计 · 输入 ${contextUsage.inputTokens.toLocaleString()} · 输出 ${contextUsage.outputTokens.toLocaleString()} · 缓存读 ${contextUsage.cacheReadTokens.toLocaleString()} · 缓存写 ${contextUsage.cacheWriteTokens.toLocaleString()} · 轮次 ${contextUsage.turns} · 步数 ${contextUsage.steps} · 首字 ${(contextUsage.ttftMs / 1000).toFixed(1)}s · ${contextUsage.tokensPerSecond.toFixed(0)} tok/s\n花费按 ${modelName} 官方价估算：高峰 ${formatCNY(cost.peak)} · 空闲时段 ${formatCNY(cost.offPeak)}`}
                >
                  ↑{fmtTokens(contextUsage.inputTokens)} ↓{fmtTokens(contextUsage.outputTokens)} 步{" "}
                  {contextUsage.steps} 缓存 {cachePct}% {formatCNY(cost.peak)}
                </span>
                {/* A rule, not a gap: the numbers left of it are session totals,
                    the ones right of it are how full the context is. Without it
                    the cache % and the context % read as one pair. */}
                <span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border-main)]" />
                {/* The breakdown is heuristic and does NOT sum to the anchored
                    total — the host README is explicit about that. */}
                <span
                  className={`mac-meter shrink-0 ${meterClass}`}
                  title={`上下文 ${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} token · 系统 ${fmtTokens(contextUsage.systemTokens)} · 工具 ${fmtTokens(contextUsage.toolsTokens)} · 消息 ${fmtTokens(contextUsage.messageTokens)}`}
                >
                  <i style={{ width: `${contextUsage.percent}%` }} />
                </span>
                <span className="shrink-0 font-mini text-[10px] tabular-nums text-[var(--text-dim)]">
                  {Math.round(contextUsage.percent)}%
                </span>
                {isStreaming ? (
                  <button
                    onClick={onAbort}
                    title="中止 (Esc)"
                    className="flex h-[18px] w-[18px] shrink-0 items-center justify-center border border-[var(--error)]/60 text-[var(--error)] hover:bg-[var(--error)] hover:text-[var(--bg-base)]"
                  >
                    {/* 停止图标用几何块而非 ■ 字形：像素字体的全宽字形会撑破对齐 */}
                    <span className="block h-[7px] w-[7px] bg-current" />
                  </button>
                ) : (
                  <button
                    onClick={() => submit()}
                    disabled={disabled || (!value.trim() && images.length === 0)}
                    title="发送 (回车)"
                    className="flex h-[18px] w-[18px] shrink-0 items-center justify-center border border-[var(--accent)]/60 font-mini text-[10px] leading-none text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--on-accent)] disabled:opacity-30"
                  >
                    ↵
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
