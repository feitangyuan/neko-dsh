import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openExternal } from "../lib/runtime";
import type { Kernel } from "../kernel/types";

/** Where DeepSeek issues keys. Opened in the system browser, never in this window. */
const CONSOLE_URL = "https://platform.deepseek.com/api_keys";

interface ProbeResult {
  ok: boolean;
  status: number;
}

/**
 * Opened from 设置 → Model, never on its own.
 *
 * The key is checked against DeepSeek before it is stored: dsh cannot verify a
 * credential (see `provider.rs`), so a typo would otherwise surface much later
 * as a provider error on every turn. A check that could not run says nothing
 * about the key, so the second press saves it anyway.
 */
export function ApiKeyDialog({ kernel }: { kernel: Kernel }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [saveAnyway, setSaveAnyway] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const open = kernel.apiKeyPrompt === "open";

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  if (!open) return null;

  const store = () =>
    kernel.saveApiKey(value).then(
      () => {
        setValue("");
        setProblem("");
        setSaveAnyway(false);
      },
      (error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
        setBusy(false);
      }
    );

  const submit = () => {
    const key = value.trim();
    if (key === "" || busy) return;
    setBusy(true);
    setProblem("");

    if (saveAnyway) {
      store().finally(() => setBusy(false));
      return;
    }

    invoke<ProbeResult>("probe_api_key", { key })
      .then((result) => {
        if (result.ok) return store();
        setBusy(false);
        setSaveAnyway(true);
        setProblem(
          result.status === 401 || result.status === 403
            ? "DeepSeek 不认这把 key"
            : `DeepSeek 返回了 ${result.status}`
        );
      })
      .catch(() => {
        setBusy(false);
        setSaveAnyway(true);
        setProblem("连不上 DeepSeek，没法验证");
      });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[18vh]">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="DeepSeek API Key"
        className="mac-dialog flex w-[min(420px,92vw)] flex-col border border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] shadow-[var(--shadow-pop)]"
      >
        <div className="pinstripes flex items-center border-b border-[var(--ink)] px-2 py-1">
          <span className="flex-1 text-center text-[12px]">DeepSeek API Key</span>
        </div>

        <div className="px-4 py-4">
          <input
            ref={field}
            type="password"
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder="sk-…"
            onChange={(event) => {
              setValue(event.target.value);
              /* Anything retyped deserves a fresh check. */
              setSaveAnyway(false);
              setProblem("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            className="field-input font-mono"
          />
          <div className="mt-2 flex items-baseline gap-3">
            <span className="flex-1 text-[12px] text-[var(--error)]">{problem}</span>
            <button
              onClick={() => openExternal(CONSOLE_URL)}
              className="font-mini shrink-0 text-[10px] text-[var(--ink-dim)] underline underline-offset-2 hover:text-[var(--ink)]"
            >
              去开放平台创建 →
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--ink)] px-4 py-2.5">
          <button
            onClick={kernel.dismissApiKeyPrompt}
            disabled={busy}
            className="mac-btn px-3 text-[12px] disabled:opacity-40"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy || value.trim() === ""}
            className="mac-btn mac-btn-primary px-3 text-[12px] disabled:opacity-40"
          >
            {busy ? "核对中…" : saveAnyway ? "仍然保存" : "保存"}
          </button>
        </div>
      </section>
    </div>
  );
}
