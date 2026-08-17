import { useEffect, useMemo, useState } from "react";
import type { SessionMeta, SessionSearchHit } from "../kernel/types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/* 侧栏可调宽：范围刻意收窄，最宽≈预览面板的默认宽度（340） */
const MIN_W = 200;
const MAX_W = 360;

interface Props {
  sessions: SessionMeta[];
  activeId: string;
  collapsed: boolean;
  width: number;
  onResize: (w: number) => void;
  onCollapse: () => void;
  pinnedProjects: string[];
  searchHits: SessionSearchHit[] | null;
  onSearch: (query: string) => void;
  onAddProject: () => void;
  onOpen: (sessionId: string) => void;
  onNew: () => void;
  onNewInProject: (cwd: string) => void;
  onPinProject: (cwd: string) => void;
  onDeleteProject: (cwd: string) => void;
  onRenameSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenSettings: () => void;
  onOpenScheduled: () => void;
  onOpenPlugins: () => void;
  onOpenPresets: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 时`;
  return `${Math.floor(h / 24)} 天`;
}

/** agent 的会话属于项目（cwd），不是 chatbot 的扁平时间线 */
function projectName(cwd: string): string {
  const segs = cwd.replace(/\/+$/, "").split("/");
  return segs[segs.length - 1] || cwd;
}

interface ProjectGroup {
  cwd: string;
  name: string;
  items: SessionMeta[];
}

export function Sidebar({
  sessions,
  activeId,
  collapsed,
  width,
  onResize,
  onCollapse,
  pinnedProjects,
  searchHits,
  onSearch,
  onAddProject,
  onOpen,
  onNew,
  onNewInProject,
  onPinProject,
  onDeleteProject,
  onRenameSession,
  onDeleteSession,
  onOpenSettings,
  onOpenScheduled,
  onOpenPlugins,
  onOpenPresets,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [dragging, setDragging] = useState(false);

  /* 右缘拖拽调宽：与预览面板同一手感——宽度 = 光标 x，拖动中关过渡动画 */
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent) =>
      onResize(Math.min(MAX_W, Math.max(MIN_W, ev.clientX)));
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /* 输入即搜：本地按标题/路径过滤是即时的，全文命中稍后由运行时补上 */
  useEffect(() => {
    onSearch(query);
  }, [onSearch, query]);

  /** sessionId → 命中片段，用于行 tooltip；null 表示没在搜 */
  const snippets = useMemo(() => {
    if (searchHits === null) return null;
    return new Map(searchHits.map((hit) => [hit.sessionId, hit.snippet]));
  }, [searchHits]);

  /* workspace 顺序即显示顺序，没有会话的项目也要出现 */
  const projects = useMemo<ProjectGroup[]>(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, SessionMeta[]>();
    for (const project of pinnedProjects) {
      if (!q || project.toLowerCase().includes(q) || projectName(project).toLowerCase().includes(q)) {
        map.set(project, []);
      }
    }
    for (const s of sessions) {
      /* 两条过滤是并集：全文索引的分词对中文按整段切，命中不了「目录」这种子串，
         所以本地标题过滤不能被它取代 */
      const local = s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q);
      if (q && !local && !snippets?.has(s.id)) continue;
      if (!map.has(s.cwd)) map.set(s.cwd, []);
      map.get(s.cwd)?.push(s);
    }
    const order = new Map(pinnedProjects.map((path, index) => [path, index]));
    return [...map.entries()]
      .map(([cwd, items]) => ({ cwd, name: projectName(cwd), items }))
      .sort((a, b) => (order.get(a.cwd) ?? Infinity) - (order.get(b.cwd) ?? Infinity));
  }, [sessions, query, pinnedProjects, snippets]);

  const toggleProject = (cwd: string) =>
    setClosedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  const openMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  /* dsh 的 workspace 没有置顶标志，顺序本身就是顺序，所以只有「挪到最前」 */
  const projectItems = (p: ProjectGroup): ContextMenuItem[] => [
    { label: "在这里新建会话", onSelect: () => onNewInProject(p.cwd) },
    { label: "移到最前", onSelect: () => onPinProject(p.cwd) },
    { label: "移除项目…", danger: true, onSelect: () => onDeleteProject(p.cwd) },
  ];

  const sessionItems = (s: SessionMeta): ContextMenuItem[] => [
    { label: "重命名会话…", onSelect: () => onRenameSession(s.id) },
    /* dsh 归档而不是删除：日志留在磁盘上，只是不再显示 */
    { label: "归档会话…", danger: true, onSelect: () => onDeleteSession(s.id) },
  ];

  return (
    <aside
      className={`relative shrink-0 select-none overflow-hidden border-r border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] ${
        dragging ? "" : "transition-[width] duration-150 ease-out"
      }`}
      style={{ width: collapsed ? 0 : width }}
    >
      {!collapsed && (
        <div
          onMouseDown={startDrag}
          title="拖动调整宽度"
          className="absolute inset-y-0 right-0 z-20 w-[5px] cursor-col-resize"
        />
      )}
      <div className="flex h-full flex-col" style={{ width }}>
        {/* 顶部导航：新建会话（行尾带收起 ◂，行业惯例位置），下面是两个一级入口 */}
        <div className="p-1">
          <div className="group flex items-center gap-1">
            <button
              onClick={onNew}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-[12px] hover:bg-[var(--chrome-lo)]"
            >
              <span className="w-4 shrink-0 text-center">+</span>新建会话
            </button>
            {/* 收起按钮平时隐藏，hover 到顶行才出现 */}
            <button
              onClick={onCollapse}
              title="收起侧栏 (⌘B)"
              aria-label="收起侧栏"
              className="flex h-5 w-5 shrink-0 items-center justify-center font-mini text-[10px] leading-none text-[var(--ink-dim)] opacity-0 transition-opacity hover:bg-[var(--chrome-lo)] hover:text-[var(--ink)] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--accent)] group-hover:opacity-100"
            >
              ◂
            </button>
          </div>
          {/* 插件是 dsh 的主要扩展方式，和新建会话同级，不塞进设置 */}
          <button
            onClick={onOpenPlugins}
            className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-[12px] hover:bg-[var(--chrome-lo)]"
          >
            <span className="w-4 shrink-0 text-center">❖</span>插件
          </button>
          <button
            onClick={onOpenPresets}
            className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-[12px] hover:bg-[var(--chrome-lo)]"
          >
            <span className="w-4 shrink-0 text-center">◐</span>模式
          </button>
          <button
            onClick={onOpenScheduled}
            className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-[12px] hover:bg-[var(--chrome-lo)]"
          >
            <span className="w-4 shrink-0 text-center">◷</span>定时任务
          </button>
        </div>

        {/* 项目分组列表：无边线，靠分组标签与留白分区 */}
        <div className="sidebar-scroll flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-2 pb-0.5 pt-1.5">
            <span className="font-mini text-[10px] tracking-wider text-[var(--ink-dim)]">项目</span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={onAddProject}
                title="添加项目"
                aria-label="添加项目"
                className="flex h-5 w-5 items-center justify-center bg-transparent text-[12px] leading-none text-[var(--ink-dim)] hover:bg-[var(--chrome-lo)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                +
              </button>
              <button
                onClick={() => {
                  setSearchOpen((v) => !v);
                  if (searchOpen) setQuery("");
                }}
                title="筛选会话"
                aria-label="筛选会话"
                className={`flex h-5 w-5 items-center justify-center text-[12px] leading-none focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
                  searchOpen
                    ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                    : "bg-transparent text-[var(--ink-dim)] hover:bg-[var(--chrome-lo)] hover:text-[var(--ink)]"
                }`}
              >
                ⌕
              </button>
            </div>
          </div>
          {searchOpen && (
            <div className="border-b border-[var(--chrome-lo)] p-1">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="筛选会话…"
                className="h-5 w-full border border-[var(--ink)] bg-[var(--chrome-hi)] px-1 font-mini text-[10px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-dim)]"
              />
            </div>
          )}
          {projects.map((p) => {
            const closed = closedProjects.has(p.cwd);
            const pinned = pinnedProjects.includes(p.cwd);
            return (
              <div key={p.cwd} className="mt-1">
                {/* 项目行：点击折叠，右键菜单，hover 出「项目内新建」 */}
                <div
                  onClick={() => toggleProject(p.cwd)}
                  onContextMenu={(e) => openMenu(e, projectItems(p))}
                  title={p.cwd}
                  className="group flex w-full cursor-default items-center gap-1 px-1.5 py-0.5 text-left text-[12px] hover:bg-[var(--chrome-lo)]"
                >
                  <span
                    className={`font-mini inline-block shrink-0 text-[10px] text-[var(--ink-dim)] transition-transform duration-150 ${
                      closed ? "" : "rotate-90"
                    }`}
                  >
                    ▸
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {pinned && (
                    <span className="font-mini shrink-0 text-[10px] text-[var(--ink-dim)]">⚑</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewInProject(p.cwd);
                    }}
                    title="在这个项目里新建会话"
                    className="hidden h-5 w-5 shrink-0 items-center justify-center text-[12px] leading-none text-[var(--ink-dim)] hover:bg-[var(--chrome)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] group-hover:flex"
                  >
                    +
                  </button>
                </div>
                {!closed &&
                  p.items.map((s) => {
                    const active = s.id === activeId;
                    return (
                      <button
                        key={s.id}
                        onClick={() => onOpen(s.id)}
                        onContextMenu={(e) => openMenu(e, sessionItems(s))}
                        title={snippets?.get(s.id) ?? s.title}
                        className={`flex w-full items-baseline gap-1.5 py-1 pl-5 pr-1.5 text-left ${
                          active
                            ? "bg-[var(--ink)] text-[var(--chrome-hi)]"
                            : "hover:bg-[var(--chrome-lo)]"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-[12px]">{s.title}</span>
                        <span
                          className={`shrink-0 font-mini text-[10px] ${
                            active ? "text-[var(--chrome)]" : "text-[var(--ink-dim)]"
                          }`}
                        >
                          {timeAgo(s.updatedAt)}
                        </span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
          {projects.length === 0 && (
            <div className="mt-6 text-center font-mini text-[10px] text-[var(--ink-dim)]">
              (没有匹配)
            </div>
          )}
        </div>

        {/* 底部：左下设置入口。连接掉线走 Toast，不在这里留常驻小灯。 */}
        <div className="flex h-7 items-center border-t border-[var(--ink)] px-1 py-1">
          <button
            onClick={onOpenSettings}
            title="设置"
            className="flex h-5 w-5 items-center justify-center text-[15px] leading-none text-[var(--ink)] hover:bg-[var(--chrome-lo)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] active:translate-y-px"
          >
            ⚙
          </button>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
