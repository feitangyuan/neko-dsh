import { useEffect, useState } from "react";
import type { Kernel } from "../kernel/types";
import { SettingGroup, WindowTitle } from "./panelChrome";
import { PopupMenu } from "./PopupMenu";

/**
 * 模式面板（dsh 里叫 agent preset）。
 *
 * 一个模式 = 一套指令 + 一批工具 + 一个默认 Model，dsh 自带四个。这是 dsh 最有价值的
 * 结构之一，但命令行里只有 `--agent-preset` 一个参数，没人会去翻——所以给它一个一级入口，
 * 顺带把「复制一份改成自己的」这条路铺平：系统模式只读，复制出来的落进 profile 目录，
 * 能改能删。
 */
export function PresetsPanel({
  open,
  kernel,
  onClose,
}: {
  open: boolean;
  kernel: Kernel;
  onClose: () => void;
}) {
  const [viewing, setViewing] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const { readPreset } = kernel;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !kernel.dialogRequest) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, kernel.dialogRequest, onClose]);

  /* 面板关掉再开，展开的正文不该还留着上一次的 */
  useEffect(() => {
    if (!open) {
      setViewing("");
      setContent("");
    }
  }, [open]);

  if (!open) return null;

  const current = kernel.currentPreset || kernel.agentPresets.find((p) => p.isDefault)?.id || "";

  /**
   * One row, one act: picking a mode.
   *
   * A blank session can still be recomposed, so it moves with the choice;
   * once a turn has landed `agentPreset.select` answers `agent-preset-locked`
   * and only the next session can follow. Either way the choice is written to
   * `agent-presets/default`, so there is one control and not two.
   */
  const choose = (id: string) => {
    if (!kernel.presetLocked) kernel.selectPreset(id);
    kernel.setDefaultPreset(id);
  };

  const toggleView = (id: string) => {
    if (viewing === id) {
      setViewing("");
      return;
    }
    setViewing(id);
    setContent("");
    setLoading(true);
    readPreset(id)
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch(() => {
        setContent("读不出来");
        setLoading(false);
      });
  };

  return (
    <div
      className="overlay-in fixed inset-0 z-40 flex items-start justify-center bg-black/35 pt-[9vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="模式"
        className="mac-dialog flex h-[min(680px,84vh)] w-[min(720px,92vw)] flex-col border border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] shadow-[var(--shadow-pop)]"
      >
        <WindowTitle title="模式" onClose={onClose} />

        <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg-surface)] text-[var(--text-main)]">
          <SettingGroup hint={kernel.presetsAuthorable ? undefined : "运行时不让改"}>
            {kernel.agentPresets.map((preset) => {
              const chosen = preset.isDefault;
              const broken = preset.broken !== "";
              /* The live session only lags the choice when it was composed before
                 the switch — say so on the row it is actually running, and stay
                 silent the rest of the time. */
              const lagging = preset.id === current && !chosen;
              return (
                <div key={preset.id} className="border-b border-[var(--border-subtle)] py-1.5 last:border-b-0">
                  <div className="flex min-h-10 items-center gap-3">
                    {/* The whole row is the control. Everything else on it is a
                        side errand and lives under the ⋯ menu. */}
                    <button
                      onClick={() => choose(preset.id)}
                      disabled={chosen || broken}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left disabled:cursor-default"
                    >
                      <span className="relative mt-[3px] h-[11px] w-[11px] shrink-0 border border-[var(--ink)] bg-[var(--chrome-hi)]">
                        {chosen && <span className="absolute inset-[2px] block bg-[var(--ink)]" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-[12px]">{preset.name}</span>
                          {lagging && (
                            <span className="font-mini shrink-0 border border-[var(--accent)] px-1 py-px text-[10px] text-[var(--accent)]">
                              当前会话
                            </span>
                          )}
                          {preset.trust === "user" && (
                            <span className="font-mini shrink-0 text-[10px] text-[var(--text-muted)]">
                              自建
                            </span>
                          )}
                          {broken && (
                            <span
                              title={preset.broken}
                              className="font-mini shrink-0 border border-[var(--error)] px-1 py-px text-[10px] text-[var(--error)]"
                            >
                              坏了
                            </span>
                          )}
                        </span>
                        <span className="font-mini block text-[10px] leading-relaxed text-[var(--text-muted)]">
                          {preset.description === "" ? preset.id : preset.description}
                        </span>
                      </span>
                    </button>
                    <PopupMenu
                      trigger="⋯"
                      plain
                      chevron={false}
                      width={160}
                      items={[
                        { value: "view", label: viewing === preset.id ? "收起内容" : "查看内容" },
                        ...(kernel.presetsAuthorable
                          ? [{ value: "copy", label: "复制一份" }]
                          : []),
                        ...(preset.trust === "user"
                          ? [
                              { value: "edit", label: "编辑" },
                              { value: "remove", label: "删除" },
                            ]
                          : []),
                      ]}
                      onSelect={(action) => {
                        if (action === "view") toggleView(preset.id);
                        else if (action === "copy") kernel.copyPreset(preset.id);
                        else if (action === "edit") kernel.openPresetDocument(preset.id);
                        else if (action === "remove") kernel.removePreset(preset.id);
                      }}
                    />
                  </div>
                  {viewing === preset.id && (
                    <pre className="mt-1.5 max-h-[280px] overflow-auto border border-[var(--border-subtle)] bg-[var(--bg-base)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-muted)]">
                      {loading ? "读取中…" : content}
                    </pre>
                  )}
                </div>
              );
            })}
          </SettingGroup>
        </div>
      </section>
    </div>
  );
}
