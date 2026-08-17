import { useEffect, useState } from "react";
import type { GoalState, JobEntry, Kernel, SubagentEntry, TimelineMessage, TodoItem } from "../kernel/types";
import { ChunkView } from "./chunks";

/**
 * 会话正在发生什么。
 *
 * dsh 把目标、待办、子 Agent、后台任务都跑在会话里，但 transcript 只看得到
 * 模型说的话——这条带子把这四件事摆到对话上面。四段都为空时整条不渲染。
 */

const PHASE: Record<GoalState["phase"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "卡住了",
  complete: "已完成",
};

const TODO_MARK: Record<TodoItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
};

const JOB_STATUS: Record<string, string> = {
  running: "运行中",
  stopping: "正在停",
  completed: "已完成",
  killed: "已终止",
  failed: "失败",
};

/** 一段的头：三角 + 标题 + 计数。几段的头挤在同一行里。 */
function SectionHead({
  title,
  count,
  open,
  onToggle,
}: {
  title: string;
  count: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    /* A section head is never smaller than the body under it — 10px mini is
       for metadata only (counts, timestamps, badges). */
    <button
      onClick={onToggle}
      className="flex items-baseline gap-1.5 text-[12px] text-[var(--text-dim)] hover:text-[var(--text-main)]"
    >
      <span className="inline-block w-[7px] shrink-0 text-center">{open ? "▾" : "▸"}</span>
      {title}
      <span className="font-mini text-[10px] tabular-nums">{count}</span>
    </button>
  );
}

/** 段内的小按钮，形态跟 composer 控制条一致 */
function MiniButton({
  onClick,
  children,
  danger = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`border px-1 font-mini text-[10px] leading-[14px] ${
        danger
          ? "border-[var(--error)]/50 text-[var(--error)] hover:bg-[var(--error)] hover:text-[var(--bg-base)]"
          : "border-[var(--border-main)] text-[var(--text-dim)] hover:border-[var(--text-main)] hover:text-[var(--text-main)]"
      }`}
    >
      {children}
    </button>
  );
}

function GoalBody({ goal }: { goal: GoalState }) {
  return (
    <>
      <div className="text-[12px] leading-relaxed text-[var(--text-main)]">{goal.objective}</div>
      {goal.blockedReason && (
        <div className="pt-0.5 font-mini text-[10px] text-[var(--error)]">{goal.blockedReason}</div>
      )}
    </>
  );
}

function TodoBody({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="space-y-0.5">
      {todos.map((item, index) => (
        <li
          key={`${index}-${item.content}`}
          className={`flex gap-1.5 text-[12px] leading-snug ${
            item.status === "completed"
              ? "text-[var(--text-dim)] line-through"
              : item.status === "in_progress"
                ? "text-[var(--accent)]"
                : "text-[var(--text-main)]"
          }`}
        >
          <span className="shrink-0 font-mini text-[10px] leading-[17px]">{TODO_MARK[item.status]}</span>
          <span className="min-w-0 flex-1">{item.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** 展开的子 Agent：按需拉一次它自己的 transcript */
function SubagentBody({ kernel, child }: { kernel: Kernel; child: SubagentEntry }) {
  const [messages, setMessages] = useState<TimelineMessage[] | null>(null);
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let dropped = false;
    kernel
      .loadSubagentHistory(child.id, child.mode)
      .then((items) => {
        if (!dropped) setMessages(items);
      })
      .catch((reason) => {
        if (!dropped) setError(String(reason?.message ?? reason));
      });
    return () => {
      dropped = true;
    };
  }, [child.id, child.mode, kernel, round]);

  /* 可续的子 Agent 有自己的线程，追问不经过主会话 */
  const followUp = child.mode === "continuable" && (
    <div className="mt-1 flex items-center gap-1.5">
      <input
        value={draft}
        disabled={sending}
        placeholder="给它追一句…"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          const text = draft.trim();
          if (text === "") return;
          setSending(true);
          void kernel.promptSubagent(child.id, text).then((ok) => {
            setSending(false);
            if (!ok) return;
            setDraft("");
            setRound((n) => n + 1);
          });
        }}
        className="min-w-0 flex-1 border border-[var(--border-main)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[12px] text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/60 disabled:opacity-50"
      />
      <MiniButton onClick={() => setRound((n) => n + 1)}>刷新</MiniButton>
    </div>
  );

  if (error) return <div className="py-1 font-mini text-[10px] text-[var(--error)]">{error}</div>;
  if (messages === null) return <div className="py-1 font-mini text-[10px] text-[var(--text-dim)]">读取中…</div>;

  return (
    /* Hang under the label, not under the disclosure triangle (7px + 6px gap). */
    <div className="ml-[13px] mt-0.5 border-l border-[var(--border-main)] pl-2">
      {messages.length === 0 ? (
        <div className="py-1 font-mini text-[10px] text-[var(--text-dim)]">(还没有内容)</div>
      ) : (
        <div className="max-h-[240px] space-y-1 overflow-y-auto">
          {messages.map((message) => (
            <div key={message.id}>
              {message.role === "user" && (
                <div className="text-[12px] text-[var(--accent)]">❯ {message.content}</div>
              )}
              {message.role === "assistant" &&
                message.chunks.map((chunk, index) => (
                  <ChunkView key={index} chunk={chunk} isLast={false} markdown />
                ))}
            </div>
          ))}
        </div>
      )}
      {followUp}
    </div>
  );
}

function SubagentBodyList({ kernel, subagents }: { kernel: Kernel; subagents: SubagentEntry[] }) {
  const [expanded, setExpanded] = useState<string>("");

  return (
    <>
      {/* Same row shape as 后台任务 below: label on the left, its metadata
          right-aligned. The disclosure triangle takes the leading slot, so the
          activity marker rides with the trailing text instead of doubling up on
          two tiny glyphs at the head of the row. */}
      <ul className="space-y-0.5">
        {subagents.map((child) => (
          <li key={child.id}>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setExpanded((held) => (held === child.id ? "" : child.id))}
                className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left text-[12px] text-[var(--text-main)] hover:text-[var(--accent)]"
              >
                <span className="inline-block w-[7px] shrink-0 text-center font-mini text-[10px] text-[var(--text-dim)]">
                  {expanded === child.id ? "▾" : "▸"}
                </span>
                <span className="min-w-0 flex-1 truncate">{child.label || child.id.slice(0, 8)}</span>
                <span className="shrink-0 font-mini text-[10px] text-[var(--text-dim)]">
                  {child.mode === "continuable" ? "可续" : "一次性"}
                </span>
                <span
                  className={`shrink-0 font-mini text-[10px] ${
                    child.activity === "running" ? "text-[var(--accent)]" : "text-[var(--text-dim)]"
                  }`}
                >
                  {child.activity === "running" ? "跑着" : "结束"}
                </span>
              </button>
              {/* 一次性子 Agent 跟着自己那一轮结束，没有可中止的东西 */}
              {child.mode === "continuable" && child.activity === "running" && (
                <MiniButton danger onClick={() => kernel.interruptSubagent(child.id)}>
                  中止
                </MiniButton>
              )}
            </div>
            {expanded === child.id && <SubagentBody kernel={kernel} child={child} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function JobBody({ jobs }: { jobs: JobEntry[] }) {
  return (
    <ul className="space-y-0.5">
      {jobs.map((job) => (
        <li key={job.id} className="flex items-baseline gap-1.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{job.label}</span>
          {job.detail && (
            <span className="shrink-0 truncate font-mini text-[10px] text-[var(--text-dim)]">{job.detail}</span>
          )}
          {/* The status word already says it — a coloured square in front of it
              was the same fact twice. */}
          <span
            className={`shrink-0 font-mini text-[10px] ${
              job.status === "running" ? "text-[var(--accent)]" : "text-[var(--text-dim)]"
            }`}
          >
            {JOB_STATUS[job.status] ?? job.status}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 会话正在发生什么。
 *
 * 只报告已经存在的东西，不提供入口：计划模式和目标是 dsh 两个不相干的概念
 * （`plan-mode` 是协作状态，`goal` 是多轮目标追踪），把定目标的输入框挂在计划模式下面
 * 纯属自作聪明——点「计划」冒出「目标」，谁都看不懂。要定目标就 `/goal <内容>`，
 * 那是 dsh 自己注册的命令，斜杠菜单里本来就有。
 */
interface Panel {
  key: string;
  title: string;
  count: string;
  right?: React.ReactNode;
  body: React.ReactNode;
}

/** 跑完的后台任务不会从列表里消失，所以这儿自己挑：还在动的，或者出了事的。 */
const JOB_LIVE = new Set(["running", "stopping", "failed"]);

export function SessionStrip({ kernel }: { kernel: Kernel }) {
  const { goal, subagents, isStreaming } = kernel;
  const [closed, setClosed] = useState<Record<string, boolean>>({ subagents: true, jobs: true });
  const toggle = (key: string) => setClosed((held) => ({ ...held, [key]: !held[key] }));

  /* 待办是模型这一轮的清单，dsh 要到下一轮开始才清空。轮次结束之后它既不会再变，
     也不代表现在在做什么——留着就是一条永远不会消失的旧账。 */
  const todos = isStreaming ? kernel.todos : [];
  const jobs = kernel.jobs.filter((job) => JOB_LIVE.has(job.status));

  const panels: Panel[] = [];
  if (goal) {
    const rounds = goal.maxGoalRounds > 0 ? ` ${goal.roundsStarted}/${goal.maxGoalRounds}` : "";
    panels.push({
      key: "goal",
      title: "目标",
      count: `${PHASE[goal.phase]}${rounds}`,
      right: (
        <>
          {goal.phase === "active" && <MiniButton onClick={() => kernel.updateGoal("pause")}>暂停</MiniButton>}
          {goal.phase === "paused" && <MiniButton onClick={() => kernel.updateGoal("resume")}>继续</MiniButton>}
          {goal.phase !== "complete" && (
            <MiniButton onClick={() => kernel.updateGoal("complete")}>完成</MiniButton>
          )}
          <MiniButton danger onClick={() => kernel.updateGoal("clear")}>
            清除
          </MiniButton>
        </>
      ),
      body: <GoalBody goal={goal} />,
    });
  }
  if (todos.length > 0) {
    const done = todos.filter((item) => item.status === "completed").length;
    panels.push({
      key: "todos",
      title: "待办",
      count: `${done}/${todos.length}`,
      body: <TodoBody todos={todos} />,
    });
  }
  if (subagents.length > 0) {
    const running = subagents.filter((child) => child.activity === "running").length;
    panels.push({
      key: "subagents",
      title: "子 Agent",
      count: running > 0 ? `${running} 跑着 / ${subagents.length}` : `${subagents.length}`,
      body: <SubagentBodyList kernel={kernel} subagents={subagents} />,
    });
  }
  if (jobs.length > 0) {
    const running = jobs.filter((job) => job.status === "running").length;
    panels.push({
      key: "jobs",
      title: "后台任务",
      count: running > 0 ? `${running} 跑着 / ${jobs.length}` : `${jobs.length}`,
      body: <JobBody jobs={jobs} />,
    });
  }
  if (panels.length === 0) return null;

  return (
    /* Same 820px column as the timeline, the queue strip and the composer —
       a full-bleed box in the middle of a centred stack reads as a different app.

       The heads share one row and the box is only as wide as it needs to be:
       a section per row meant that with everything folded the strip was a stack
       of 820px bars each holding one short label and a lot of nothing. */
    <div className="shrink-0 px-5 pb-1">
      <div className="mx-auto max-w-[820px]">
        <div className="w-fit max-w-full border border-[var(--border-main)] bg-[var(--bg-surface)]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
            {panels.map((panel) => (
              <div key={panel.key} className="flex items-center gap-1.5">
                <SectionHead
                  title={panel.title}
                  count={panel.count}
                  open={!closed[panel.key]}
                  onToggle={() => toggle(panel.key)}
                />
                {panel.right}
              </div>
            ))}
          </div>
          {panels
            .filter((panel) => !closed[panel.key])
            .map((panel) => (
              <div key={panel.key} className="border-t border-[var(--border-main)] px-2 py-1">
                {panel.body}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
