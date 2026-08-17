import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  Kernel,
  SchemaJSON,
  SchemaNode,
  SettingsNamespaceView,
  SettingsSnapshot,
  UsageDay,
  UsageHistory,
  UsageTokens,
} from "../kernel/types";
import { FONT_SIZES } from "../kernel/shellPrefs";
import { asPreference } from "../kernel/theme";
import {
  BAND_LABEL,
  BAND_SHORT,
  OFF_PEAK_RATE,
  bandAtHour,
  beijingHour,
  costOf,
  formatCNY,
  nextBandChange,
  otherBand,
  type Band,
} from "../kernel/pricing";
import { SettingGroup, WindowTitle } from "./panelChrome";
import { PopupMenu } from "./PopupMenu";

/** The one curated field this shell has to act on itself. */
const THEME_NS = "ui-theme";
const THEME_KEY = "preference";

/**
 * Settings.
 *
 * dsh registers a schemastery schema per namespace — 11 namespaces, ~40 fields,
 * almost all of them runtime knobs (shell timeouts, stream idle windows, retry
 * policies) carrying no labels or descriptions. Rendering that wholesale leaks
 * the runtime's shape into the product, so the panes below are a hand-written
 * whitelist: real names, real explanations, translated enum values. Everything
 * else stays reachable under 高级, still generated from the schema so a plugin
 * installed later is never invisible.
 */

/* 插件不在这里——它是侧栏一级入口，见 `PluginsPanel`。 */
type SectionId = "general" | "usage" | "advanced" | "about";

const SECTIONS: { id: SectionId; icon: string; label: string }[] = [
  { id: "general", icon: "⌘", label: "常规" },
  { id: "usage", icon: "▦", label: "用量" },
  { id: "advanced", icon: "▥", label: "高级" },
  { id: "about", icon: "ⓘ", label: "关于" },
];

/** Panes that fetch their own data — the settings snapshot says nothing about them. */
const SELF_LOADING = new Set<SectionId>(["usage", "about"]);

/** One whitelisted field. `key` is a top-level key of its namespace object. */
interface CuratedField {
  ns: string;
  key: string;
  label: string;
  choices?: Record<string, string>; // schema enum value → 中文
  emptyLabel?: string; // shown while the field is still on its default
}

interface CuratedGroup {
  title: string;
  fields: CuratedField[];
}

const GENERAL_GROUPS: CuratedGroup[] = [
  {
    title: "外观",
    fields: [
      {
        ns: "ui-theme",
        key: "preference",
        label: "主题",
        choices: { light: "浅色", dark: "深色", system: "跟随系统" },
      },
      /* No 语言 row. dsh's `locale` namespace drives its own browser client's
         copy, which this shell replaced; our text is Chinese either way, so the
         switch would have been a control that changes nothing. */
    ],
  },
  {
    title: "对话",
    fields: [
      {
        ns: "ui-conversation",
        key: "busyEnter",
        label: "生成时按回车",
        choices: { queue: "排到下一轮", steer: "插进当前这一轮" },
      },
    ],
  },
  /* No 看图 group. The seeded `@linxin666/dsh-tool-describe-image` arrives with
     its endpoint already set by `dsh.rs::write_overlay`, so there is nothing here
     for a user to fill in. Its `describe-image` namespace still reaches the
     advanced list below like every other one — which is the escape hatch for the
     day that free endpoint goes away. */
];

/* No 思考深度 / 允许范围 rows. Both pickers sit on the composer, and both now
   write the matching default when used (`selectRoute` / `setPermission`), so a
   second copy here would be the same switch drawn twice. */

export function SettingsPanel({ kernel }: { kernel: Kernel }) {
  const [section, setSection] = useState<SectionId>("general");
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    kernel
      .describeSettings()
      .then((next) => {
        setSnapshot(next);
        setError("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [kernel]);

  useEffect(() => {
    if (kernel.settingsOpen) load();
  }, [kernel.settingsOpen, load]);

  useEffect(() => {
    if (!kernel.settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      /* A dialog raised from inside settings owns Esc first. */
      if (event.key === "Escape" && !kernel.dialogRequest) kernel.closeSettings();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [kernel]);

  /** Replace one namespace in place; a write answers with its new view. */
  const applyView = useCallback((view: SettingsNamespaceView) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            namespaces: current.namespaces.map((item) => (item.ns === view.ns ? view : item)),
          }
        : current
    );
  }, []);

  const writable = snapshot?.writable !== false;

  if (!kernel.settingsOpen) return null;

  return (
    <div
      className="overlay-in fixed inset-0 z-40 flex items-start justify-center bg-black/35 pt-[9vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) kernel.closeSettings();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="mac-dialog flex h-[min(680px,84vh)] w-[min(940px,92vw)] flex-col border border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] shadow-[var(--shadow-pop)]"
      >
        <WindowTitle title="设置" onClose={kernel.closeSettings} />
        <div className="flex min-h-0 flex-1">
          <nav className="w-[158px] shrink-0 border-r border-[var(--ink)] bg-[var(--chrome)] p-1.5">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                onClick={() => setSection(item.id)}
                aria-current={section === item.id ? "page" : undefined}
                className={`mb-0.5 flex w-full items-center gap-2 border px-2 py-1.5 text-left text-[12px] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
                  /* Solid accent, not the soft wash: --accent-soft is mixed for the
                     dark content surface and turns beige over the always-light
                     chrome, taking --accent-strong down with it. */
                  section === item.id
                    ? "border-[var(--border-main)] bg-[var(--accent)] text-[var(--on-accent)]"
                    : "border-transparent hover:bg-[var(--chrome-lo)]"
                }`}
              >
                <span className="font-mini flex w-4 shrink-0 items-center justify-center text-[12px]">
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </nav>

          {/* The content column is a document surface, so it takes the --text-*
              family. --ink belongs to the window furniture (chrome stays light in
              both themes) and would be black-on-black here under the dark tokens. */}
          <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg-surface)] text-[var(--text-main)]">
            {error !== "" && !SELF_LOADING.has(section) && (
              <p className="px-4 pt-3 text-[12px] text-[var(--error)]">读取设置失败：{error}</p>
            )}
            {snapshot === null && error === "" && !SELF_LOADING.has(section) && (
              <p className="px-4 pt-3 text-[12px] text-[var(--text-muted)]">正在读取…</p>
            )}

            {section === "general" && (
              <>
                <CuratedGroups
                  groups={GENERAL_GROUPS}
                  extras={{
                    外观: (
                      <SettingRow label="界面字号">
                        <PopupMenu
                          trigger={`${kernel.uiFontSize}px`}
                          items={FONT_SIZES.map((size) => ({
                            value: String(size),
                            label: `${size}px`,
                          }))}
                          activeValue={String(kernel.uiFontSize)}
                          onSelect={(value) => kernel.setUiFontSize(Number(value))}
                          width={120}
                        />
                      </SettingRow>
                    ),
                    对话: (
                      <>
                        <SettingRow
                          label="新会话的起始目录"
                          detail={kernel.startDir === "" ? "个人文件夹" : kernel.startDir}
                        >
                          {kernel.startDir !== "" && (
                            <button
                              onClick={() => kernel.setStartDir("")}
                              className="mac-btn px-2 text-[12px]"
                            >
                              清除
                            </button>
                          )}
                          <button
                            onClick={kernel.pickStartDir}
                            className="mac-btn px-2 text-[12px]"
                          >
                            选择…
                          </button>
                        </SettingRow>
                        <SettingRow label="跑完了弹 Dock 图标">
                          <PopupMenu
                            trigger={kernel.notifyOnIdle ? "开" : "关"}
                            items={[
                              { value: "on", label: "开" },
                              { value: "off", label: "关" },
                            ]}
                            activeValue={kernel.notifyOnIdle ? "on" : "off"}
                            onSelect={(value) => kernel.setNotifyOnIdle(value === "on")}
                            width={100}
                          />
                        </SettingRow>
                      </>
                    ),
                  }}
                  snapshot={snapshot}
                  writable={writable}
                  kernel={kernel}
                  onApply={applyView}
                  onReload={load}
                />
                <SettingGroup title="凭据">
                  {/* dsh 的凭据接口按契约就是只写不读，界面里也没有可看的值。
                      设过没设过，「设置 / 更换」这个按钮自己就说清楚了。 */}
                  <SettingRow label="DeepSeek API Key">
                    <button onClick={kernel.setApiKey} className="mac-btn px-2 text-[12px]">
                      {kernel.apiKeyConfigured ? "更换" : "设置"}
                    </button>
                  </SettingRow>
                </SettingGroup>
              </>
            )}

            {section === "usage" && <Usage kernel={kernel} />}

            {section === "advanced" && (
              <Advanced
                snapshot={snapshot}
                writable={writable}
                kernel={kernel}
                onApply={applyView}
                onReload={load}
              />
            )}

            {section === "about" && (
              <About
                kernel={kernel}
                writable={writable}
                hasDocument={snapshot?.hasDocument === true}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------------- curated panes ---------------- */

function CuratedGroups({
  groups,
  extras,
  snapshot,
  writable,
  kernel,
  onApply,
  onReload,
}: {
  groups: CuratedGroup[];
  /* Rows this shell owns, appended to the dsh-backed group of the same title —
     a preference the runtime never heard of still belongs next to its kin. */
  extras?: Record<string, ReactNode>;
  snapshot: SettingsSnapshot | null;
  writable: boolean;
  kernel: Kernel;
  onApply: (view: SettingsNamespaceView) => void;
  onReload: () => void;
}) {
  if (!snapshot) return null;
  const byNs = new Map(snapshot.namespaces.map((view) => [view.ns, view]));

  return (
    <>
      {groups.map((group) => {
        /* A field whose namespace is not loaded is dropped rather than shown
           broken — the plugin providing it simply is not in this profile. */
        const rows = group.fields
          .map((field) => ({ field, view: byNs.get(field.ns) }))
          .filter((row): row is { field: CuratedField; view: SettingsNamespaceView } =>
            row.view !== undefined
          );
        const extra = extras?.[group.title];
        if (rows.length === 0 && extra === undefined) return null;

        const restart = rows.some((row) => row.view.applies === "restart");
        return (
          <SettingGroup
            key={group.title}
            title={group.title}
            hint={restart ? "改完需要重启应用" : undefined}
          >
            {rows.map(({ field, view }) => (
              <CuratedRow
                key={`${field.ns}.${field.key}`}
                field={field}
                view={view}
                writable={writable}
                kernel={kernel}
                onApply={onApply}
                onReload={onReload}
              />
            ))}
            {extra}
          </SettingGroup>
        );
      })}
    </>
  );
}

function CuratedRow({
  field,
  view,
  writable,
  kernel,
  onApply,
  onReload,
}: {
  field: CuratedField;
  view: SettingsNamespaceView;
  writable: boolean;
  kernel: Kernel;
  onApply: (view: SettingsNamespaceView) => void;
  onReload: () => void;
}) {
  const write = useWrite(view, kernel, onApply, onReload);
  const root = nodeAt(view.schema, view.schema?.uid);
  const node = nodeAt(view.schema, root?.dict?.[field.key]);
  if (!node) return null;

  const value = (view.value as Record<string, unknown>)?.[field.key];
  const overridden = (view.user as Record<string, unknown> | undefined)?.[field.key] !== undefined;

  return (
    <SettingRow
      label={field.label}
      onReset={
        overridden && writable ? () => write([field.key], undefined, true) : undefined
      }
    >
      <FieldControl
        schema={view.schema}
        node={node}
        value={value}
        secret={false}
        disabled={!writable}
        labels={field.choices}
        emptyLabel={field.emptyLabel}
        onChange={(next) => write([field.key], next)}
      />
    </SettingRow>
  );
}

/* ---------------- plugins ---------------- */

/**
 * The plugin pane.
 *
 * Installing is not an `/api` call — `dsh plugin` forwards to pnpm and rewrites
 * the profile's layer list, which the runtime only reads at boot. So the pane
 * has a restart affordance, and the two states it shows are deliberately
 * distinct: 已装 (in the profile) and 运行中 (loaded by this process).
 */
/** 1.2万 → 12.0k，两位有效数字够看趋势了 */
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * 两种刻度。日刻度看这个月的起伏，周刻度看一个季度的走向。
 * 都是定长坐标轴，右端永远是今天/本周——不然装完第一天就两根柱子，
 * 会被 flex 撑成两个巨块，看着像柱状图其实什么也没说明。
 */
type UsageScale = "day" | "week";
const USAGE_SPAN: Record<UsageScale, number> = { day: 30, week: 12 };

/** `YYYY-MM-DD`，本地时区——和 kernel 归集用的是同一套口径 */
function dateKey(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/** 从 `YYYY-MM-DD` 取本地日期，正午起算：夏令时那天加减 24 小时会跳过或重复一天 */
function localDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** 周一为一周之始 */
function startOfWeek(at: Date): Date {
  const out = new Date(at);
  out.setHours(12, 0, 0, 0);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

/** 一格坐标轴上的累计值。`date` 是这一格的起始日 */
interface UsageBucket extends UsageTokens {
  date: string;
  sessions: number;
  peak: UsageTokens;
  offPeak: UsageTokens;
}

function noTokens(): UsageTokens {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function emptyBucket(date: string): UsageBucket {
  return { date, sessions: 0, ...noTokens(), peak: noTokens(), offPeak: noTokens() };
}

function addTokens(target: UsageTokens, next: UsageTokens): UsageTokens {
  return {
    inputTokens: target.inputTokens + next.inputTokens,
    outputTokens: target.outputTokens + next.outputTokens,
    cacheReadTokens: target.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + next.cacheWriteTokens,
  };
}

function addUsage(target: UsageBucket, day: UsageDay | UsageBucket): UsageBucket {
  return {
    date: target.date,
    sessions: target.sessions + day.sessions,
    ...addTokens(target, day),
    peak: addTokens(target.peak, day.peak),
    offPeak: addTokens(target.offPeak, day.offPeak),
  };
}

function bucketTokens(bucket: UsageTokens): number {
  return (
    bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
  );
}

/** 一格（或一档）实际花了多少：两个时段各按各的价算完再相加。 */
function bucketCost(bucket: UsageBucket, route: string): number {
  return costOf(bucket.peak, route, "peak") + costOf(bucket.offPeak, route, "offPeak");
}

/** 定长坐标轴，旧→新，右端是今天/本周 */
function usageAxis(days: UsageDay[], scale: UsageScale): UsageBucket[] {
  const anchor = new Date();
  anchor.setHours(12, 0, 0, 0);
  const byKey = new Map<string, UsageBucket>();
  for (const day of days) {
    const key = scale === "day" ? day.date : dateKey(startOfWeek(localDate(day.date)));
    byKey.set(key, addUsage(byKey.get(key) ?? emptyBucket(key), day));
  }
  const head = scale === "day" ? anchor : startOfWeek(anchor);
  const axis: UsageBucket[] = [];
  for (let back = USAGE_SPAN[scale] - 1; back >= 0; back -= 1) {
    const at = new Date(head);
    at.setDate(head.getDate() - back * (scale === "day" ? 1 : 7));
    const key = dateKey(at);
    axis.push(byKey.get(key) ?? emptyBucket(key));
  }
  return axis;
}

function bucketLabel(bucket: UsageBucket, scale: UsageScale, todayKey: string): string {
  const start = localDate(bucket.date);
  if (scale === "day") {
    return bucket.date === todayKey
      ? "今天"
      : `${start.getMonth() + 1}月${start.getDate()}日`;
  }
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${start.getMonth() + 1}/${start.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`;
}

/* 时段的填充，时段条和柱状图共用一套，看一眼就知道两处说的是同一件事。
   经典 Mac 没有彩色可用，靠抖动纹理区分——实心 = 高峰（贵），斜纹 = 空闲（五折）。 */
const BAND_FILLS: Record<Band, CSSProperties> = {
  peak: { background: "var(--text-main)" },
  offPeak: {
    backgroundImage: "repeating-linear-gradient(45deg, var(--text-main) 0 1px, transparent 1px 3px)",
  },
};

const BANDS: Band[] = ["peak", "offPeak"];

/** 柱高只算输入 + 输出 + 缓存写入：缓存命中常常大一个量级，混进去会把所有柱子压平。 */
function barTokens(tokens: UsageTokens): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheWriteTokens;
}

/** 一天 24 格的时段条。填满的是高峰，斜纹的是空闲，当前这一格套上强调色。 */
function BandStrip({ hour }: { hour: number }) {
  return (
    <div>
      <div className="flex gap-px border border-[var(--border-main)] p-px">
        {Array.from({ length: 24 }, (_, at) => (
          <div
            key={at}
            title={`${String(at).padStart(2, "0")}:00 ${BAND_LABEL[bandAtHour(at)]}`}
            className="h-3 min-w-0 flex-1"
            /* 当前这一格整格换成强调色：斜纹上再套一圈细边框根本看不出来，
               而下面那行已经把现在是哪个档写清楚了。 */
            style={
              at === hour ? { background: "var(--accent)" } : BAND_FILLS[bandAtHour(at)]
            }
          />
        ))}
      </div>
      <div className="font-mini flex pt-0.5 text-[10px] tabular-nums text-[var(--text-muted)]">
        {Array.from({ length: 24 }, (_, at) => (
          <span key={at} className="min-w-0 flex-1 text-center">
            {at % 6 === 0 ? at : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 用量。
 *
 * 整个面板绕着 DeepSeek 的两个计费档转：**高峰时段**（北京时间 9:00–12:00、
 * 14:00–18:00）和**空闲时段**（其余，官方五折）。同样一批 token，跑的时候是哪个档，
 * 账单差一倍——所以这里不再显示一个"高峰价上界"，而是把两档分开摆。
 *
 * token 全部来自运行时自己的 projection，前端只做加法。金额是壳这边按官方价目表
 * 算的（见 `kernel/pricing.ts`），dsh 不提供价格。
 *
 * ⚠️ 归档口径见 `UsageDay`：projection 只有累计值，所以整个会话记在它最后活动那一刻
 * 所在的档位。跨档的长会话会被算到收尾的那一档，这是已知的近似，别当成精确账单。
 */
function Usage({ kernel }: { kernel: Kernel }) {
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [scale, setScale] = useState<UsageScale>("day");
  const [hover, setHover] = useState<number | null>(null);
  const [error, setError] = useState("");
  /* 时段条要跟着真实时间走，每分钟对一次表就够——换档只发生在整点。 */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const { describeUsage } = kernel;
  /* 历史里没有 Model 归属：`session.list` 的 projection 只有 token 数。
     所以整段历史都按当前选中的这一档算，档位名写在标题上，不当默认值藏着。 */
  const route = kernel.currentModel;
  const modelName =
    kernel.availableModels.find((item) => item.id === route)?.name ?? "DeepSeek";

  const load = useCallback(() => {
    describeUsage()
      .then((next) => {
        setHistory(next);
        setError("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [describeUsage]);

  useEffect(() => load(), [load]);

  const todayKey = dateKey(new Date());
  const axis = useMemo(
    () => usageAxis(history?.days ?? [], scale),
    [history?.days, scale]
  );

  /* 今天 / 本周 / 本月三格，和右边的「全部」拼成一排读数。 */
  const summary = useMemo(() => {
    const days = history?.days ?? [];
    const weekKey = dateKey(startOfWeek(new Date()));
    const monthPrefix = todayKey.slice(0, 7);
    let today = emptyBucket(todayKey);
    let week = emptyBucket(weekKey);
    let month = emptyBucket(monthPrefix);
    for (const day of days) {
      if (day.date === todayKey) today = addUsage(today, day);
      if (dateKey(startOfWeek(localDate(day.date))) === weekKey) week = addUsage(week, day);
      if (day.date.startsWith(monthPrefix)) month = addUsage(month, day);
    }
    return { today, week, month };
  }, [history?.days, todayKey]);

  if (error !== "") {
    return <p className="px-4 pt-3 text-[12px] text-[var(--error)]">读取失败：{error}</p>;
  }
  if (history === null) {
    return <p className="px-4 pt-3 text-[12px] text-[var(--text-muted)]">正在统计…</p>;
  }

  const { totals } = history;
  const all: UsageBucket = { date: "", ...totals };
  const heights = axis.map((bucket) => barTokens(bucket));
  const tallest = Math.max(1, ...heights);
  const empty = heights.every((value) => value === 0);
  /* 默认停在最高的那一格：一进来就该看见最贵的那天是哪天。 */
  const readIndex = hover ?? heights.indexOf(tallest);
  const read = axis[readIndex];
  const change = nextBandChange(now);
  /* 全部用量如果都挪到空闲时段跑，账单会是多少——差额就是这个面板存在的理由。 */
  const saving = bucketCost(all, route) - costOf(all, route, "offPeak");

  return (
    <>
      <SettingGroup title="时段" hint="北京时间">
        <div className="pb-1 pt-2">
          <BandStrip hour={beijingHour(now)} />
        </div>
        {/* 三行同级，就得同字号：读数一律走 Tally，别在这儿手搓一行小字。 */}
        <Tally label="现在" value={BAND_LABEL[change.band]} />
        <Tally
          label="下次换档"
          value={`${String(change.hour).padStart(2, "0")}:00 转${
            BAND_LABEL[otherBand(change.band)]
          }`}
        />
        <Tally label="空闲时段单价" value={`高峰的 ${OFF_PEAK_RATE * 10} 折`} />
      </SettingGroup>

      <SettingGroup
        title="花费"
        hint={`${totals.sessions} 个会话 · ${totals.turns} 轮 · 按 ${modelName} 官方价估算`}
      >
        <div className="my-1.5 border border-[var(--border-main)]">
          {/* 表头和数据行同一个字号：表头比正文小就成了小字注解，不是表头了。 */}
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-b border-[var(--border-main)] px-2.5 py-1 text-[12px] text-[var(--text-muted)]">
            <span />
            {BANDS.map((band) => (
              <span key={band} className="w-14 text-right">
                {BAND_SHORT[band]}
              </span>
            ))}
            <span className="w-14 text-right">合计</span>
          </div>
          <CostRow label="今天" bucket={summary.today} route={route} />
          <CostRow label="本周" bucket={summary.week} route={route} />
          <CostRow label="本月" bucket={summary.month} route={route} />
          <CostRow label="全部" bucket={all} route={route} last />
        </div>
        <Tally label="全挪到空闲时段可省" value={formatCNY(saving)} />
        <div className="grid grid-cols-2 gap-x-6">
          <Tally label="输入" value={compactTokens(totals.inputTokens)} />
          <Tally label="输出" value={compactTokens(totals.outputTokens)} />
          <Tally label="缓存命中" value={compactTokens(totals.cacheReadTokens)} />
          <Tally label="缓存写入" value={compactTokens(totals.cacheWriteTokens)} />
        </div>
      </SettingGroup>

      <SettingGroup title="走势" hint="按会话最后活动那天计">
        <div className="flex items-center justify-between gap-3 py-1.5">
          <div
            role="group"
            aria-label="统计刻度"
            className="flex border border-[var(--border-main)]"
          >
            {(["day", "week"] as const).map((option) => (
              <button
                key={option}
                onClick={() => {
                  setScale(option);
                  setHover(null);
                }}
                aria-pressed={scale === option}
                className={`h-[var(--ui-control-height)] px-2.5 text-[12px] leading-none focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
                  scale === option
                    ? "bg-[var(--accent)] text-[var(--on-accent)]"
                    : "hover:bg-[var(--bg-base)]"
                }`}
              >
                {option === "day" ? "按天 · 30 天" : "按周 · 12 周"}
              </button>
            ))}
          </div>
          <Legend />
        </div>

        {empty ? (
          <p className="pb-3 text-[12px] text-[var(--text-muted)]">还没有可统计的会话。</p>
        ) : (
          <>
            <div
              className="flex h-28 items-end gap-[2px] border-b border-[var(--border-main)] pb-px"
              onMouseLeave={() => setHover(null)}
            >
              {axis.map((bucket, index) => {
                const total = heights[index];
                if (total === 0) {
                  return (
                    <div
                      key={bucket.date}
                      onMouseEnter={() => setHover(index)}
                      className="flex h-full flex-1 flex-col justify-end"
                    >
                      <div className="h-px w-full bg-[var(--border-subtle)]" />
                    </div>
                  );
                }
                const height = Math.max(2, Math.round((total / tallest) * 104));
                return (
                  <div
                    key={bucket.date}
                    onMouseEnter={() => setHover(index)}
                    className="flex h-full min-w-0 flex-1 flex-col justify-end"
                    style={{
                      outline: index === readIndex ? "1px solid var(--accent)" : undefined,
                      outlineOffset: "1px",
                    }}
                  >
                    <div className="flex w-full flex-col" style={{ height }}>
                      {BANDS.map((band) =>
                        barTokens(bucket[band]) > 0 ? (
                          <div
                            key={band}
                            style={{
                              ...BAND_FILLS[band],
                              height: `${(barTokens(bucket[band]) / total) * 100}%`,
                            }}
                          />
                        ) : null
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-[2px]">
              {axis.map((bucket, index) => (
                <span
                  key={bucket.date}
                  className={`font-mini min-w-0 flex-1 truncate pt-0.5 text-center text-[10px] tabular-nums ${
                    index === axis.length - 1 ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
                  }`}
                >
                  {scale === "day"
                    ? localDate(bucket.date).getDate()
                    : `${localDate(bucket.date).getMonth() + 1}/${localDate(bucket.date).getDate()}`}
                </span>
              ))}
            </div>

            {/* 读数行跟着指针走，不用 tooltip：30 根柱子逐个悬停等提示太慢了。 */}
            <div className="font-mini flex h-5 items-center truncate pb-1 text-[10px] tabular-nums text-[var(--text-muted)]">
              <span className="truncate">
                {bucketLabel(read, scale, todayKey)}
                {`　${formatCNY(bucketCost(read, route))}（高峰 ${formatCNY(
                  costOf(read.peak, route, "peak")
                )} · 空闲 ${formatCNY(
                  costOf(read.offPeak, route, "offPeak")
                )}）· 输入 ${compactTokens(read.inputTokens)} · 输出 ${compactTokens(
                  read.outputTokens
                )} · 缓存 ${compactTokens(read.cacheReadTokens)}/${compactTokens(
                  read.cacheWriteTokens
                )} · ${read.sessions} 个会话`}
              </span>
            </div>
          </>
        )}
      </SettingGroup>

      <div className="px-4 pb-4 pt-1">
        <button onClick={load} className="mac-btn px-3 text-[12px]">
          重新统计
        </button>
      </div>
    </>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-2.5">
      {/* 和左边的刻度按钮同一行，就得和它们同字号——简称是为了这个字号还塞得下。 */}
      {BANDS.map((band) => (
        <span
          key={band}
          className="flex items-center gap-1 text-[12px] text-[var(--text-muted)]"
        >
          <i
            className="block h-2 w-2 border border-[var(--border-main)]"
            style={BAND_FILLS[band]}
          />
          {BAND_SHORT[band]}
        </span>
      ))}
    </div>
  );
}

/** 花费表的一行：高峰、空闲各按各的价，右边是两档相加。 */
function CostRow({
  label,
  bucket,
  route,
  last = false,
}: {
  label: string;
  bucket: UsageBucket;
  route: string;
  last?: boolean;
}) {
  const peak = costOf(bucket.peak, route, "peak");
  const offPeak = costOf(bucket.offPeak, route, "offPeak");
  return (
    <div
      className={`grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-4 px-2.5 py-1.5 ${
        last ? "" : "border-b border-[var(--border-subtle)]"
      }`}
      title={`${compactTokens(bucketTokens(bucket))} token · ${bucket.sessions} 个会话`}
    >
      <span className="truncate text-[12px]">{label}</span>
      <span className="font-mono w-14 text-right text-[12px] tabular-nums text-[var(--text-muted)]">
        {formatCNY(peak)}
      </span>
      <span className="font-mono w-14 text-right text-[12px] tabular-nums text-[var(--text-muted)]">
        {formatCNY(offPeak)}
      </span>
      <span className="font-mono w-14 text-right text-[12px] tabular-nums">
        {formatCNY(peak + offPeak)}
      </span>
    </div>
  );
}

function Tally({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-[var(--border-subtle)] py-1.5">
      <span className="text-[12px]">{label}</span>
      <span className="font-mono ml-auto text-[12px]">{value}</span>
    </div>
  );
}

/* ---------------- advanced (schema-driven) ---------------- */

function Advanced({
  snapshot,
  writable,
  kernel,
  onApply,
  onReload,
}: {
  snapshot: SettingsSnapshot | null;
  writable: boolean;
  kernel: Kernel;
  onApply: (view: SettingsNamespaceView) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const namespaces = useMemo(() => snapshot?.namespaces ?? [], [snapshot]);

  return (
    <>
      {!open ? (
        <div className="p-4">
          {/* A chrome-coloured card inside the document column: it carries its own
              --ink, because chrome is light under both themes. */}
          <div className="border border-[var(--ink)] bg-[var(--chrome-hi)] p-4 text-[var(--ink)]">
            <p className="text-[12px] leading-relaxed">
              dsh 运行时注册的全部配置项，改错了会影响运行时行为。
            </p>
            <button onClick={() => setOpen(true)} className="mac-btn mt-3 px-3 text-[12px]">
              我知道，展开（{namespaces.length} 组）
            </button>
          </div>
        </div>
      ) : (
        namespaces.map((view) => (
          <NamespaceForm
            key={view.ns}
            view={view}
            writable={writable}
            kernel={kernel}
            onApply={onApply}
            onReload={onReload}
          />
        ))
      )}
    </>
  );
}

/* ---------------- schema walking ---------------- */

function nodeAt(schema: SchemaJSON, uid: number | undefined): SchemaNode | undefined {
  if (uid === undefined) return undefined;
  return schema.refs?.[String(uid)];
}

/** A union of consts is an enum; anything else is left to the document. */
function enumValues(schema: SchemaJSON, node: SchemaNode): string[] | null {
  if (node.type !== "union" || !node.list) return null;
  const values: string[] = [];
  for (const uid of node.list) {
    const member = nodeAt(schema, uid);
    if (!member || member.type !== "const" || typeof member.value !== "string") return null;
    values.push(member.value);
  }
  return values.length > 0 ? values : null;
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} 项`;
  return `${Object.keys(value as object).length} 个字段`;
}

/** Path-addressed write shared by both panes; a stale revision forces a reload. */
function useWrite(
  view: SettingsNamespaceView,
  kernel: Kernel,
  onApply: (view: SettingsNamespaceView) => void,
  onReload: () => void
) {
  return useCallback(
    (path: string[], value: unknown, remove = false) => {
      kernel
        .mutateSettings(
          view.ns,
          [remove ? { op: "unset", path } : { op: "set", path, value }],
          view.revision
        )
        .then((next) => {
          onApply(next);
          /* The value is stored by dsh but painted by this shell, so a write has
             to reach the DOM itself. Routed here so the curated row and the raw
             advanced form both repaint — via the kernel, the only writer. */
          if (view.ns === THEME_NS && path.length === 1 && path[0] === THEME_KEY) {
            kernel.syncTheme(asPreference(next.value?.[THEME_KEY]));
          }
        })
        .catch((cause: unknown) => {
          kernel.notify(cause instanceof Error ? cause.message : String(cause), "error");
          onReload();
        });
    },
    [kernel, onApply, onReload, view.ns, view.revision]
  );
}

function NamespaceForm({
  view,
  writable,
  kernel,
  onApply,
  onReload,
}: {
  view: SettingsNamespaceView;
  writable: boolean;
  kernel: Kernel;
  onApply: (view: SettingsNamespaceView) => void;
  onReload: () => void;
}) {
  const root = nodeAt(view.schema, view.schema?.uid);
  const fields = root?.dict ? Object.entries(root.dict) : [];
  const secrets = new Map(view.secrets.map((slot) => [slot.path.join("."), slot.set]));
  const write = useWrite(view, kernel, onApply, onReload);

  if (fields.length === 0) return null;

  return (
    <SettingGroup
      title={view.ns}
      hint={view.applies === "restart" ? "改完需要重启应用" : undefined}
    >
      {fields.map(([key, uid]) => {
        const node = nodeAt(view.schema, uid);
        if (!node) return null;
        const value = (view.value as Record<string, unknown>)?.[key];
        const overridden = (view.user as Record<string, unknown> | undefined)?.[key] !== undefined;
        const secretSet = secrets.get(key);
        return (
          <SettingRow
            key={key}
            label={key}
            detail={
              secretSet !== undefined
                ? secretSet
                  ? "已设置"
                  : "未设置"
                : overridden
                  ? "已改动"
                  : "默认值"
            }
            onReset={overridden && writable ? () => write([key], undefined, true) : undefined}
          >
            <FieldControl
              schema={view.schema}
              node={node}
              value={value}
              secret={secretSet !== undefined}
              disabled={!writable}
              onChange={(next) => write([key], next)}
            />
          </SettingRow>
        );
      })}
    </SettingGroup>
  );
}

function FieldControl({
  schema,
  node,
  value,
  secret,
  disabled,
  labels,
  emptyLabel,
  onChange,
}: {
  schema: SchemaJSON;
  node: SchemaNode;
  value: unknown;
  secret: boolean;
  disabled: boolean;
  labels?: Record<string, string>;
  emptyLabel?: string;
  onChange: (value: unknown) => void;
}) {
  const choices = enumValues(schema, node);

  if (secret) return <SecretInput disabled={disabled} onSubmit={onChange} />;

  if (choices) {
    const shown =
      typeof value === "string"
        ? (labels?.[value] ?? value)
        : (emptyLabel ?? describeValue(value));
    return (
      <PopupMenu
        trigger={<span className="max-w-[200px] truncate">{shown}</span>}
        items={choices.map((choice) => ({ value: choice, label: labels?.[choice] ?? choice }))}
        activeValue={typeof value === "string" ? value : undefined}
        onSelect={(next) => !disabled && onChange(next)}
        width={200}
      />
    );
  }

  if (node.type === "boolean") {
    return (
      <ToggleButton enabled={value === true} onClick={() => !disabled && onChange(value !== true)} />
    );
  }

  if (node.type === "number") {
    return (
      <TextInput
        value={value === undefined || value === null ? "" : String(value)}
        disabled={disabled}
        numeric
        onCommit={(text) => {
          const parsed = Number(text);
          if (text.trim() === "" || Number.isNaN(parsed)) return;
          onChange(parsed);
        }}
      />
    );
  }

  if (node.type === "string") {
    return (
      <TextInput
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onCommit={(text) => onChange(text)}
      />
    );
  }

  /* Objects, arrays and dicts: shown, not edited. A generic form would have to
     invent a structure editor, and getting it wrong here writes bad config.
     Same size as the inputs it sits beside — it's this row's value, not a footnote. */
  return (
    <span className="text-[12px] text-[var(--text-muted)]" title="改这一项请用设置文档">
      {describeValue(value)}
    </span>
  );
}

function TextInput({
  value,
  disabled,
  numeric,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  numeric?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      disabled={disabled}
      inputMode={numeric ? "numeric" : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(value);
      }}
      className={`h-[var(--ui-control-height)] w-[200px] border border-[var(--ink)] bg-[var(--chrome-hi)] px-2 text-[12px] text-[var(--ink)] outline-none disabled:opacity-50 ${
        numeric ? "text-right tabular-nums" : ""
      }`}
    />
  );
}

/** Write-only: the value never comes back down, so the box always starts empty. */
function SecretInput({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="password"
        value={draft}
        disabled={disabled}
        placeholder="输入新值…"
        onChange={(event) => setDraft(event.target.value)}
        className="h-[var(--ui-control-height)] w-[150px] border border-[var(--ink)] bg-[var(--chrome-hi)] px-2 text-[12px] text-[var(--ink)] outline-none disabled:opacity-50"
      />
      <button
        className="mac-btn px-2 text-[12px]"
        disabled={disabled || draft.trim() === ""}
        onClick={() => {
          onSubmit(draft);
          setDraft("");
        }}
      >
        保存
      </button>
    </div>
  );
}

/* ---------------- about ---------------- */

function About({
  kernel,
  writable,
  hasDocument,
}: {
  kernel: Kernel;
  writable: boolean;
  hasDocument: boolean;
}) {
  return (
    <>
      <div className="p-4">
        <div className="border border-[var(--ink)] bg-[var(--chrome-hi)] p-4 text-center text-[var(--ink)]">
          <div className="font-mono text-[28px] tracking-[0.16em] text-[var(--accent)]">NEKO</div>
          <div className="mt-1 text-[12px]">
            dsh {kernel.runtimeVersion === "" ? "—" : kernel.runtimeVersion}
          </div>
          <div className="font-mini mt-1 text-[10px] text-[var(--text-muted)]">
            Powered by DeepSeek Harness
          </div>
        </div>

        <SettingGroup title="配置文件">
          <SettingRow label="设置文档">
            <button
              onClick={kernel.openSettingsDocument}
              disabled={!hasDocument}
              /* 灰掉的原因藏在 hover 里：界面上不留解释小字。 */
              title={hasDocument ? undefined : "当前设置源不是文件，没有可打开的文档"}
              className="mac-btn px-2 text-[12px] disabled:opacity-40"
            >
              打开
            </button>
          </SettingRow>
        </SettingGroup>

        {!writable && (
          <p className="font-mini mt-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
            当前设置源是只读的。
          </p>
        )}
      </div>
    </>
  );
}

/* ---------------- row pieces（窗框件在 panelChrome.tsx） ---------------- */

function SettingRow({
  label,
  detail,
  onReset,
  children,
}: {
  label: string;
  /* Only ever state — what the value currently is, never how the row works. */
  detail?: string;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-4 border-b border-[var(--border-subtle)] py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[12px]">{label}</div>
        {detail && (
          /* One line, always. A wrapped path turns a 40px row into a 60px one and
             drags every control on it out of alignment; the full string is on the
             hover title. */
          <div
            title={detail}
            className="font-mini truncate text-[10px] leading-relaxed text-[var(--text-muted)]"
          >
            {detail}
          </div>
        )}
      </div>
      {onReset && (
        <button
          onClick={onReset}
          title="恢复默认"
          className="font-mini shrink-0 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)]"
        >
          重置
        </button>
      )}
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ToggleButton({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      onClick={onClick}
      className={`mac-toggle ${enabled ? "is-on" : ""}`}
    >
      <span />
    </button>
  );
}
