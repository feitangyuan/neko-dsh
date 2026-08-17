import { useEffect, useState } from "react";
import type { Kernel } from "../kernel/types";

/**
 * dsh names the entry it could not import:
 * `failed to import loader entry plugin-vet (dsh-plugin-vetting): …`
 * The package in the parentheses is the one to offer removing.
 */
const FAILED_ENTRY = /failed to import loader entry \S+ \(([^)]+)\)/;

/**
 * The runtime failed to start.
 *
 * This is not a corner case: a third-party plugin that throws on import takes the
 * whole plugin tree down with it, and this app ships no terminal — measured
 * 2026-08-16 with `dsh-plugin-vetting@0.5.1`, a published version whose
 * `lib/index.js` does not parse. Without a way out from inside the window, one
 * bad install would be unrecoverable.
 */
export function BootFailure({ kernel }: { kernel: Kernel }) {
  const [busy, setBusy] = useState(false);
  const { bootError, refreshPlugins } = kernel;

  useEffect(() => {
    if (bootError !== "") refreshPlugins();
  }, [bootError, refreshPlugins]);

  if (bootError === "") return null;

  const named = FAILED_ENTRY.exec(bootError)?.[1];
  /* Only offer to remove something this app can actually remove: a built-in layer
     is not a profile dependency, and pnpm would refuse. */
  const culprit = kernel.plugins.find((entry) => entry.name === named && entry.removable);
  const removable = kernel.plugins.filter((entry) => entry.removable);

  const run = (action: Promise<unknown>) => {
    setBusy(true);
    action.then(
      () => kernel.restartRuntime(),
      () => setBusy(false)
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[10vh]">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-label="运行时启动失败"
        className="mac-dialog flex h-[min(560px,80vh)] w-[min(760px,92vw)] flex-col border border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] shadow-[var(--shadow-pop)]"
      >
        <div className="pinstripes flex items-center border-b border-[var(--ink)] px-2 py-1">
          <span className="flex-1 text-center text-[12px]">运行时启动失败</span>
        </div>

        <div className="border-b border-[var(--ink)] px-4 py-3">
          <p className="text-[12px] leading-relaxed">
            {culprit
              ? `插件 ${culprit.name} 加载失败，把整个运行时一起带崩了。移除它就能恢复。`
              : "dsh 没能启动。下面是它自己的输出，通常最后几行就是原因。"}
          </p>
        </div>

        <pre className="min-h-0 flex-1 select-text overflow-auto bg-[var(--bg-surface)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text-main)]">
          {bootError}
        </pre>

        <div className="flex items-center gap-2 border-t border-[var(--ink)] px-4 py-2.5">
          <span className="font-mini flex-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
            {removable.length > 0
              ? "移除只动 profile 里的插件，会话记录和设置都不受影响。"
              : "没有可移除的第三方插件——问题不在插件上。"}
          </span>
          {culprit && (
            <button
              onClick={() => run(kernel.removePlugin(culprit.name))}
              disabled={busy}
              className="mac-btn shrink-0 px-3 text-[12px] disabled:opacity-40"
            >
              移除 {culprit.name}
            </button>
          )}
          {!culprit && removable.length > 0 && (
            <button
              onClick={() =>
                run(
                  removable.reduce<Promise<unknown>>(
                    /* Sequential: each removal runs pnpm in the same directory. */
                    (chain, entry) => chain.then(() => kernel.removePlugin(entry.name)),
                    Promise.resolve()
                  )
                )
              }
              disabled={busy}
              className="mac-btn shrink-0 px-3 text-[12px] disabled:opacity-40"
            >
              移除全部自装插件（{removable.length}）
            </button>
          )}
          <button
            onClick={() => run(Promise.resolve())}
            disabled={busy}
            className="mac-btn shrink-0 px-3 text-[12px] disabled:opacity-40"
          >
            重试
          </button>
        </div>
      </section>
    </div>
  );
}
