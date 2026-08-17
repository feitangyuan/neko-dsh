import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { Kernel } from "../kernel/types";
import { SettingGroup, WindowTitle } from "./panelChrome";

/**
 * 插件面板。
 *
 * 侧栏一级入口，不在设置里——插件是 dsh 的主要扩展方式，装一个包就多一批工具和命令，
 * 藏进设置的第三层等于没有。装的是 npm 包，和 `dsh plugin add` 同一批，写进 profile 的
 * 层叠列表，运行时启动时读一次。
 */

/**
 * 中文介绍，按 npm 包名索引。
 *
 * 名字一栏保持 npm 包名原文——那是装它、删它、去 npm 上查它用的标识符，翻译掉就对不上了。
 * 要换掉的是介绍：包自带的 `description` 是给 npm 页面写的英文长段（`@deepseek-ai/dsh-base`
 * 那条整整两行讲 patch layer），直接摆上界面等于没写，只有表里查不到的包才退回去用它。
 *
 * 表里带 `spec` 的会同时出现在「推荐」里。`spec` 一律钉版本：pnpm 11 有
 * `minimumReleaseAge` 门槛，发布太新的版本会被静默跳过、落回一个更老的版本——实测
 * `add dsh-plugin-vetting` 装到的是 0.5.1，那一版 lib/index.js 里有个未转义的 `/`，
 * 语法错误，插件加载失败会把整个运行时带崩（2026-08-16 实测）。
 *
 * 加新条目之前先装一遍验证：npm 上真实存在、**声明了 `dsh.bundle`**、装完确实挂进
 * 层叠列表、运行时能起来、而且不依赖 dsh 自带的浏览器界面（那套界面被这个壳换掉了）。
 * 别照着 npm 搜索结果抄——`@deepseek-ai/dsh-time-context` 看着像官方插件，实测没有
 * `dsh.bundle`，装进去只是一个不生效的普通依赖。
 */
const CATALOG: Record<string, { detail: string; spec?: string }> = {
  "@deepseek-ai/dsh-base": {
    detail: "读写文件、跑命令、记上下文，dsh 的地基",
  },
  "@deepseek-ai/dsh-web-app": {
    detail: "这个界面和 dsh 之间的本机接口",
  },
  "dsh-better-edit": {
    /* Seeded into a fresh profile by `plugins.rs::SEEDED`, so the 推荐 row only
       shows up after the user has removed it — the way back in. */
    detail: "读文件时给每行编号，改的时候按编号定位；对不上就报错，不会改错地方",
    spec: "dsh-better-edit@0.2.0",
  },
  "dsh-plugin-browser-use": {
    detail: "打开网页、点按钮、填表单、读正文；登录一次会记住，下次还是登录状态",
    spec: "dsh-plugin-browser-use@0.3.1",
  },
  "@linxin666/dsh-tool-describe-image": {
    detail: "DeepSeek 不收图，装了它就能往对话里贴图：转写文字、读图表、看界面截图",
    spec: "@linxin666/dsh-tool-describe-image@0.1.19",
  },
  "dsh-find-plugin": {
    detail: "让模型在对话里搜插件：按 GitHub 的 dsh-plugin 标签找，按 star 排序",
    spec: "dsh-find-plugin@0.3.6",
  },
  "dsh-plugin-vetting": {
    detail: "装第三方插件前先做静态检查：可疑的外发、凭据读取、越权路径",
    spec: "dsh-plugin-vetting@0.5.6",
  },
};

const SUGGESTED = Object.entries(CATALOG)
  .filter(([, item]) => item.spec !== undefined)
  .map(([name, item]) => ({ name, ...item, spec: item.spec as string }));

/** npm 上带 dsh-plugin 标记的包，社区就在这儿发。 */
const REGISTRY = "https://www.npmjs.com/search?q=keywords%3Adsh-plugin";

export function PluginsPanel({
  open,
  kernel,
  onClose,
}: {
  open: boolean;
  kernel: Kernel;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [restartPending, setRestartPending] = useState(false);
  const { refreshPlugins } = kernel;

  useEffect(() => {
    if (open) refreshPlugins();
  }, [open, refreshPlugins]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      /* A dialog raised from inside this panel owns Esc first. */
      if (event.key === "Escape" && !kernel.dialogRequest) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, kernel.dialogRequest, onClose]);

  if (!open) return null;

  const installed = new Set(kernel.plugins.map((entry) => entry.name));
  const suggestions = SUGGESTED.filter((item) => !installed.has(item.name));
  const busy = kernel.pluginsBusy;

  const install = (spec: string) =>
    kernel.installPlugin(spec).then(
      () => {
        setRestartPending(true);
        setDraft("");
      },
      () => undefined
    );

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
        aria-label="插件"
        className="mac-dialog flex h-[min(680px,84vh)] w-[min(720px,92vw)] flex-col border border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] shadow-[var(--shadow-pop)]"
      >
        <WindowTitle title="插件" onClose={onClose} />

        {/* 内容区是文档面，用 --text-* 一族；--ink 属于窗框（深色下窗框仍是浅的） */}
        <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg-surface)] text-[var(--text-main)]">

          {restartPending && (
            <div className="px-4 pt-3">
              <div className="flex items-center gap-3 border border-[var(--ink)] bg-[var(--chrome-hi)] p-3 text-[var(--ink)]">
                <p className="flex-1 text-[12px] leading-relaxed">
                  插件列表已经变了，重启运行时后生效。
                </p>
                <button
                  onClick={kernel.restartRuntime}
                  disabled={busy}
                  className="mac-btn shrink-0 px-3 text-[12px] disabled:opacity-40"
                >
                  重启
                </button>
              </div>
            </div>
          )}

          <SettingGroup title="已装" hint={busy ? "正在处理…" : undefined}>
            {kernel.plugins.length === 0 && (
              <p className="font-mini py-2 text-[10px] text-[var(--text-muted)]">
                还没有装任何插件。
              </p>
            )}
            {kernel.plugins.map((entry) => {
              const known = CATALOG[entry.name];
              return (
              <div
                key={entry.name}
                className="flex min-h-10 items-center gap-3 border-b border-[var(--border-subtle)] py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  {/* 名字 + 一句话，别的都砍了。名字是 npm 包名原文，不翻译。 */}
                  <div className="truncate font-mono text-[12px]">{entry.name}</div>
                  {/* 唯一保留的状态文案是装了不生效——那不是修饰信息，
                      不说的话用户会一直等一个永远不来的功能。 */}
                  <div className="font-mini truncate text-[10px] leading-relaxed text-[var(--text-muted)]">
                    {entry.removable && !entry.active
                      ? "装上了但不会生效：这个包没声明 dsh.bundle"
                      : (known?.detail ?? entry.description ?? "")}
                  </div>
                </div>
                {entry.removable && (
                  <button
                    onClick={() =>
                      kernel.removePlugin(entry.name).then(
                        () => setRestartPending(true),
                        () => undefined
                      )
                    }
                    disabled={busy}
                    className="mac-btn shrink-0 px-2 text-[12px] disabled:opacity-40"
                  >
                    卸载
                  </button>
                )}
              </div>
              );
            })}
          </SettingGroup>

          {suggestions.length > 0 && (
            <SettingGroup title="推荐">
              {suggestions.map((item) => (
                <div
                  key={item.name}
                  className="flex min-h-10 items-center gap-3 border-b border-[var(--border-subtle)] py-1.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px]">{item.name}</div>
                    <div className="font-mini truncate text-[10px] leading-relaxed text-[var(--text-muted)]">
                      {item.detail}
                    </div>
                  </div>
                  <button
                    onClick={() => void install(item.spec)}
                    disabled={busy}
                    className="mac-btn shrink-0 px-2 text-[12px] disabled:opacity-40"
                  >
                    安装
                  </button>
                </div>
              ))}
            </SettingGroup>
          )}

          <SettingGroup title="更多插件">
            <div className="py-2">
              <button
                onClick={() => void invoke("open_external", { url: REGISTRY })}
                className="mac-btn px-3 text-[12px]"
              >
                去 npm 上找插件
              </button>
            </div>
          </SettingGroup>

          <SettingGroup title="手动安装" hint="插件权限和 dsh 一样大">
            <div className="flex items-center gap-2 py-2">
              <input
                value={draft}
                disabled={busy}
                placeholder="npm 包名，例如 dsh-plugin-vetting"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && draft.trim() !== "") void install(draft.trim());
                }}
                className="field-input min-w-0 flex-1 font-mono"
              />
              <button
                onClick={() => void install(draft.trim())}
                disabled={busy || draft.trim() === ""}
                className="mac-btn shrink-0 px-3 text-[12px] disabled:opacity-40"
              >
                安装
              </button>
            </div>
          </SettingGroup>
        </div>
      </section>
    </div>
  );
}
