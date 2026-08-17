import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * 定时任务面板。
 *
 * 这是**用户级**定时任务，不是 dsh `packages/schedule` 那个会话内的模型提醒工具。
 * 到点由 macOS launchd 唤醒 app 的 worker 进程，用 dsh 的 headless profile 跑一次性任务；
 * 因为共用同一个 `$DSH_HOME`，跑完会在侧栏留下一条真实会话，点开能看全过程。
 */

type ScheduleKind = "once" | "daily" | "weekdays" | "weekly";

interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  weekday: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastOutput: string | null;
}

interface TaskDraft {
  id?: string;
  name: string;
  prompt: string;
  cwd: string;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  weekday: number | null;
  enabled: boolean;
}

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const STATUS_TEXT: Record<string, string> = {
  running: "正在跑",
  completed: "成功",
  failed: "失败",
};

/** 默认时间给一小时后，避免新建时就撞上「必须是将来」的校验 */
function defaultTime() {
  const at = new Date(Date.now() + 60 * 60 * 1000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function blankDraft(cwd: string): TaskDraft {
  return {
    name: "",
    prompt: "",
    cwd,
    scheduleKind: "daily",
    scheduleValue: defaultTime(),
    weekday: 1,
    enabled: true,
  };
}

function scheduleLabel(task: Pick<ScheduledTask, "scheduleKind" | "scheduleValue" | "weekday">) {
  if (task.scheduleKind === "once") {
    return task.scheduleValue ? new Date(task.scheduleValue).toLocaleString("zh-CN") : "单次";
  }
  if (task.scheduleKind === "daily") return `每天 ${task.scheduleValue}`;
  if (task.scheduleKind === "weekdays") return `工作日 ${task.scheduleValue}`;
  return `每${WEEKDAYS[(task.weekday ?? 1) - 1]} ${task.scheduleValue}`;
}

export function ScheduledPanel({
  open,
  cwd,
  onClose,
  onNotify,
}: {
  open: boolean;
  cwd: string;
  onClose: () => void;
  onNotify: (text: string, kind?: "info" | "success" | "error") => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [draft, setDraft] = useState<TaskDraft>(() => blankDraft(cwd));
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTasks(await invoke<ScheduledTask[]>("schedule_list"));
    } catch (error) {
      onNotify(String(error), "error");
    }
  }, [onNotify]);

  useEffect(() => {
    if (!open) return;
    setDraft((current) => (!current.id && !current.cwd && cwd ? { ...current, cwd } : current));
    void load();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cwd, load, onClose, open]);

  const selected = useMemo(
    () => tasks.find((task) => task.id === draft.id) ?? null,
    [draft.id, tasks]
  );

  if (!open) return null;

  const selectTask = (task: ScheduledTask) =>
    setDraft({
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      cwd: task.cwd,
      scheduleKind: task.scheduleKind,
      scheduleValue: task.scheduleValue,
      weekday: task.weekday,
      enabled: task.enabled,
    });

  const chooseFolder = async () => {
    try {
      const picked = await invoke<string | null>("pick_directory");
      if (picked) setDraft((current) => ({ ...current, cwd: picked }));
    } catch (error) {
      onNotify(String(error), "error");
    }
  };

  const save = async () => {
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.cwd.trim()) {
      onNotify("名字、文件夹、任务内容都要填", "error");
      return;
    }
    setBusy(true);
    try {
      const saved = await invoke<ScheduledTask>("schedule_save", { input: draft });
      await load();
      selectTask(saved);
      onNotify("已保存", "success");
    } catch (error) {
      onNotify(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (task: ScheduledTask) => {
    try {
      const updated = await invoke<ScheduledTask>("schedule_set_enabled", {
        id: task.id,
        enabled: !task.enabled,
      });
      await load();
      if (draft.id === updated.id) selectTask(updated);
    } catch (error) {
      onNotify(String(error), "error");
    }
  };

  const remove = async () => {
    if (!draft.id || !window.confirm(`删除「${draft.name}」？`)) return;
    setBusy(true);
    try {
      await invoke("schedule_delete", { id: draft.id });
      setDraft(blankDraft(cwd));
      await load();
      onNotify("已删除", "success");
    } catch (error) {
      onNotify(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!draft.id) return;
    try {
      await invoke("schedule_run_now", { id: draft.id });
      onNotify("已在后台开始跑", "success");
      /* The worker is a detached process; give it a beat before re-reading. */
      window.setTimeout(() => void load(), 1500);
    } catch (error) {
      onNotify(String(error), "error");
    }
  };

  return (
    <div
      className="overlay-in fixed inset-0 z-40 flex items-start justify-center bg-black/35 pt-[7vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="定时任务"
        className="mac-dialog flex h-[min(680px,84vh)] w-[min(860px,92vw)] flex-col border border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] shadow-[var(--shadow-pop)]"
      >
        <div className="pinstripes flex items-center border-b border-[var(--ink)] px-1.5 py-1">
          <button
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            className="relative h-[13px] w-[13px] shrink-0 border border-[var(--ink)] bg-[var(--chrome-hi)] text-[var(--ink-dim)] shadow-[1px_1px_0_rgba(0,0,0,0.4)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] active:shadow-none"
          >
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 block h-px w-[7px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current"
            />
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 block h-px w-[7px] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current"
            />
          </button>
          <span className="flex-1 text-center text-[12px]">定时任务</span>
          <span className="w-[13px]" />
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[250px] shrink-0 flex-col border-r border-[var(--ink)]">
            <div className="flex items-center gap-1 border-b border-[var(--ink)] p-1.5">
              <button
                onClick={() => setDraft(blankDraft(cwd))}
                className="mac-btn flex-1 px-2 text-[12px]"
              >
                + 新建
              </button>
              <button
                onClick={() => void load()}
                title="刷新"
                className="mac-btn px-2 text-[12px]"
              >
                ↻
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--chrome)] p-1">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => selectTask(task)}
                  className={`mb-0.5 flex w-full items-start gap-2 border px-2 py-1.5 text-left ${
                    draft.id === task.id
                      ? "border-[var(--border-main)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                      : "border-transparent hover:bg-[var(--chrome-lo)]"
                  }`}
                >
                  <span
                    title={task.enabled ? "已启用" : "已停用"}
                    className={`mt-1 h-2 w-2 shrink-0 border border-[var(--ink)] ${
                      task.enabled ? "bg-[var(--success)]" : "bg-[var(--chrome-hi)]"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px]">{task.name}</span>
                    <span className="font-mini block truncate text-[10px] text-[var(--ink-dim)]">
                      {scheduleLabel(task)}
                    </span>
                  </span>
                </button>
              ))}
              {tasks.length === 0 && (
                <div className="font-mini px-2 py-6 text-center text-[10px] leading-relaxed text-[var(--ink-dim)]">
                  还没有定时任务
                </div>
              )}
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg-surface)]">
            <header className="border-b border-[var(--border-subtle)] px-4 py-3">
              <h2 className="text-[12px]">{draft.id ? "编辑任务" : "新建任务"}</h2>
            </header>

            <div className="space-y-3 p-4">
              <Field label="名字">
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="每天早上整理昨天的改动"
                  className="field-input"
                />
              </Field>

              <Field label="在哪个文件夹跑">
                <div className="flex items-center gap-1.5">
                  <input
                    value={draft.cwd}
                    onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
                    placeholder="/Users/you/project"
                    className="field-input font-mono min-w-0 flex-1"
                  />
                  <button onClick={() => void chooseFolder()} className="mac-btn shrink-0 px-2 text-[12px]">
                    选择…
                  </button>
                </div>
              </Field>

              <Field label="让它做什么">
                <textarea
                  value={draft.prompt}
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                  placeholder="像平时说话一样写清楚要做的事…"
                  rows={6}
                  className="field-input resize-y leading-relaxed"
                />
              </Field>

              <div className="grid grid-cols-[1fr_1.15fr] gap-3">
                <Field label="重复">
                  <select
                    value={draft.scheduleKind}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        scheduleKind: event.target.value as ScheduleKind,
                        scheduleValue: event.target.value === "once" ? "" : defaultTime(),
                      })
                    }
                    className="field-input"
                  >
                    <option value="once">只跑一次</option>
                    <option value="daily">每天</option>
                    <option value="weekdays">工作日</option>
                    <option value="weekly">每周</option>
                  </select>
                </Field>
                {draft.scheduleKind === "once" ? (
                  <Field label="日期和时间">
                    <input
                      type="datetime-local"
                      value={draft.scheduleValue}
                      onChange={(event) => setDraft({ ...draft, scheduleValue: event.target.value })}
                      className="field-input"
                    />
                  </Field>
                ) : (
                  <Field label="时间">
                    <input
                      type="time"
                      value={draft.scheduleValue}
                      onChange={(event) => setDraft({ ...draft, scheduleValue: event.target.value })}
                      className="field-input"
                    />
                  </Field>
                )}
              </div>

              {draft.scheduleKind === "weekly" && (
                <Field label="星期几">
                  <select
                    value={draft.weekday ?? 1}
                    onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}
                    className="field-input"
                  >
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index + 1}>
                        {day}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <div className="flex items-center justify-between border border-[var(--border-subtle)] bg-[var(--chrome-hi)] px-2.5 py-2">
                <span>
                  <span className="block text-[12px]">启用</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-label="启用"
                  aria-checked={draft.enabled}
                  onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                  className={`mac-toggle ${draft.enabled ? "is-on" : ""}`}
                >
                  <span />
                </button>
              </div>

              {selected?.lastStatus && (
                <div className="border border-[var(--border-subtle)] bg-[var(--chrome-hi)] p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]">
                      上次运行 · {STATUS_TEXT[selected.lastStatus] ?? selected.lastStatus}
                    </span>
                    <span className="font-mini text-[10px] text-[var(--ink-dim)]">
                      {selected.lastRunAt
                        ? new Date(selected.lastRunAt).toLocaleString("zh-CN")
                        : "—"}
                    </span>
                  </div>
                  {selected.lastOutput && (
                    <pre className="font-mini mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--ink-dim)]">
                      {selected.lastOutput}
                    </pre>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
                {draft.id && (
                  <button
                    onClick={() => void remove()}
                    disabled={busy}
                    className="mac-btn px-3 text-[12px] text-[var(--error)]"
                  >
                    删除
                  </button>
                )}
                <span className="flex-1" />
                {draft.id && selected && (
                  <>
                    <button
                      onClick={() => void toggle(selected)}
                      disabled={busy}
                      className="mac-btn px-3 text-[12px]"
                    >
                      {selected.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      onClick={() => void runNow()}
                      disabled={busy}
                      className="mac-btn px-3 text-[12px]"
                    >
                      立刻跑一次
                    </button>
                  </>
                )}
                <button
                  onClick={() => void save()}
                  disabled={busy}
                  className="mac-btn mac-btn-primary px-4 text-[12px]"
                >
                  {busy ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </main>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="font-mini mb-1 block text-[10px] text-[var(--ink-dim)]">{label}</span>
      {children}
    </label>
  );
}
