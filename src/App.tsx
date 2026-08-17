import { useCallback, useEffect, useState } from "react";
import { ApiKeyDialog } from "./components/ApiKeyDialog";
import { BootFailure } from "./components/BootFailure";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { DialogHost } from "./components/DialogHost";
import { PluginsPanel } from "./components/PluginsPanel";
import { PresetsPanel } from "./components/PresetsPanel";
import { PreviewPane } from "./components/PreviewPane";
import { QueueStrip } from "./components/QueueStrip";
import { ScheduledPanel } from "./components/ScheduledPanel";
import { SessionStrip } from "./components/SessionStrip";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { Toast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { useKernel } from "./kernel/useKernel";

export default function App() {
  const kernel = useKernel();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewWidth, setPreviewWidth] = useState(340);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(232);

  /* The theme lives in the kernel (it is a persisted dsh setting), so this file
     no longer touches `data-theme` — a second writer would fight the first. */

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  /* 键盘优先：⌘K 面板 / Esc 中止 / ⌘B 侧栏 / ⌘N 新建 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        kernel.newSession();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        kernel.openSettings();
      } else if (e.key === "Escape") {
        // 弹窗和设置窗口自行处理 Esc；面板打开时优先关面板；否则中止流式
        if (kernel.dialogRequest || kernel.settingsOpen || scheduledOpen || pluginsOpen || presetsOpen)
          return;
        if (kernel.apiKeyPrompt !== "none") return;
        if (paletteOpen) {
          setPaletteOpen(false);
        } else if (kernel.isStreaming) {
          kernel.abort();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kernel, paletteOpen, scheduledOpen, pluginsOpen, presetsOpen, toggleSidebar]);

  const sessionTitle =
    kernel.sessions.find((s) => s.id === kernel.sessionId)?.title ?? "新会话";
  const topBarTitle = compactTitle(sessionTitle);

  /* 窗口标题跟随会话名 */
  useEffect(() => {
    document.title = `Neko — ${sessionTitle}`;
  }, [sessionTitle]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 通栏标题栏：经典 Mac 窗口的顶条，横跨整个窗口 */}
      <TopBar
        sessionTitle={topBarTitle}
        contentOffset={sidebarOpen ? sidebarWidth : 0}
        rightOffset={kernel.preview ? previewWidth : 0}
        previewOpen={kernel.preview !== null}
        onTogglePreview={kernel.togglePreview}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          sessions={kernel.sessions}
          activeId={kernel.sessionId}
          collapsed={!sidebarOpen}
          width={sidebarWidth}
          onResize={setSidebarWidth}
          onCollapse={toggleSidebar}
          pinnedProjects={kernel.pinnedProjects}
          searchHits={kernel.searchHits}
          onSearch={kernel.searchSessions}
          onAddProject={kernel.addProject}
          onOpen={kernel.openSession}
          onNew={kernel.newSession}
          onNewInProject={kernel.newSessionInProject}
          onPinProject={kernel.pinProject}
          onDeleteProject={kernel.deleteProject}
          onRenameSession={kernel.renameSession}
          onDeleteSession={kernel.deleteSession}
          onOpenSettings={kernel.openSettings}
          onOpenScheduled={() => setScheduledOpen(true)}
          onOpenPlugins={() => setPluginsOpen(true)}
          onOpenPresets={() => setPresetsOpen(true)}
        />

        <main className="relative flex min-w-0 flex-1 flex-col bg-[var(--bg-base)]">
          {/* 侧栏收起后，内容区左缘留一个 Control Strip 式把手，点它弹回（入口永远贴在左缘） */}
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              title="展开侧栏 (⌘B)"
              aria-label="展开侧栏"
              className="absolute left-0 top-2 z-10 flex h-12 w-[14px] items-center justify-center border border-l-0 border-[var(--ink)] bg-[var(--chrome)] font-mini text-[9px] text-[var(--ink-dim)] shadow-[1px_1px_0_rgba(0,0,0,0.35)] hover:bg-[var(--chrome-lo)] hover:text-[var(--ink)]"
            >
              ▸
            </button>
          )}
          <Timeline
            messages={kernel.messages}
            isStreaming={kernel.isStreaming}
            sessionId={kernel.sessionId}
            hasMoreHistory={kernel.hasMoreHistory}
            isLoadingHistory={kernel.isLoadingHistory}
            onLoadMore={kernel.loadMoreHistory}
            onFork={kernel.forkSession}
            onPreview={kernel.openPreview}
            onAttachment={kernel.loadAttachment}
          />

          <SessionStrip kernel={kernel} />

          <QueueStrip items={kernel.queue} onRemove={kernel.removeQueued} />

          <Composer
            isStreaming={kernel.isStreaming || kernel.isCompacting}
            disabled={kernel.connection !== "connected"}
            commands={kernel.commands}
            skills={kernel.skills}
            models={kernel.availableModels}
            currentModel={kernel.currentModel}
            onModelChange={kernel.setModel}
            thinkingLevel={kernel.thinkingLevel}
            thinkingLevels={kernel.availableThinkingLevels}
            onThinkingLevel={kernel.setThinkingLevel}
            contextUsage={kernel.contextUsage}
            plan={kernel.plan}
            onTogglePlan={kernel.togglePlanMode}
            permission={kernel.permission}
            onPermission={kernel.setPermission}
            cwd={kernel.cwd}
            pinnedProjects={kernel.pinnedProjects}
            onBindProject={kernel.bindProject}
            onChooseFolder={kernel.addProject}
            imageLimits={kernel.imageLimits}
            onSend={kernel.prompt}
            onAbort={kernel.abort}
            onCommand={kernel.executeCommand}
            onNotify={kernel.notify}
          />
        </main>

        <PreviewPane
          state={kernel.preview}
          width={previewWidth}
          onResize={setPreviewWidth}
          onClose={kernel.closePreview}
          onActivate={kernel.activatePreview}
          onCloseFile={kernel.closePreviewFile}
        />
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        kernel={kernel}
        onToggleSidebar={toggleSidebar}
        onOpenPlugins={() => setPluginsOpen(true)}
        onOpenScheduled={() => setScheduledOpen(true)}
      />

      <ScheduledPanel
        open={scheduledOpen}
        cwd={kernel.cwd}
        onClose={() => setScheduledOpen(false)}
        onNotify={kernel.notify}
      />

      <PluginsPanel open={pluginsOpen} kernel={kernel} onClose={() => setPluginsOpen(false)} />

      <PresetsPanel open={presetsOpen} kernel={kernel} onClose={() => setPresetsOpen(false)} />

      <SettingsPanel kernel={kernel} />

      <BootFailure kernel={kernel} />

      <ApiKeyDialog kernel={kernel} />

      <DialogHost request={kernel.dialogRequest} onResolve={kernel.resolveDialog} />
      <Toast notification={kernel.notification} />
    </div>
  );
}

function compactTitle(title: string): string {
  const cleaned = title
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const value = cleaned || title.trim() || "新会话";
  const characters = Array.from(value);
  return characters.length > 10 ? `${characters.slice(0, 9).join("")}…` : value;
}
