import { useEffect, useRef, useState } from "react";
import type { DialogResult, UIDialogRequest } from "../kernel/types";

interface Props {
  request: UIDialogRequest | null;
  onResolve: (id: string, result: DialogResult) => void;
}

/** 扩展弹窗宿主：经典 Mac alert 形态（灰面、黑边、偏移实影） */
export function DialogHost({ request, onResolve }: Props) {
  if (!request) return null;
  /* Keyed by id: approvals and question batches queue up, and a body carrying
     the previous request's answer into the next one would be worse than empty. */
  const body = (
    <div className="p-3.5" key={request.id}>
      {request.message && (
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--ink-dim)]">{request.message}</p>
      )}
      {request.detail && (
        <pre className="mb-3 max-h-[30vh] overflow-auto whitespace-pre-wrap break-words border border-[var(--ink)] bg-[var(--chrome-hi)] px-2.5 py-1.5 font-mini text-[10px] leading-relaxed text-[var(--ink)]">
          {request.detail}
        </pre>
      )}
      {request.dialogType === "select" && <SelectBody request={request} onResolve={onResolve} />}
      {request.dialogType === "confirm" && <ConfirmBody request={request} onResolve={onResolve} />}
      {request.dialogType === "input" && <InputBody request={request} onResolve={onResolve} />}
      {request.dialogType === "editor" && <EditorBody request={request} onResolve={onResolve} />}
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[18vh]">
      <div className="w-full max-w-[430px] border border-[var(--ink)] bg-[var(--chrome)] text-[var(--ink)] shadow-[var(--shadow-pop)]">
        <div className="pinstripes border-b border-[var(--ink)] px-3 py-1.5 text-center">
          <h2 className="pinstripes inline-block px-2 text-[12px]">{request.title}</h2>
        </div>
        {body}
      </div>
    </div>
  );
}

function Footer({
  onCancel,
  onOk,
  okLabel = "好",
  cancelLabel = "取消",
  okDisabled = false,
  okHint,
}: {
  onCancel: () => void;
  onOk: () => void;
  okLabel?: string;
  cancelLabel?: string;
  okDisabled?: boolean;
  okHint?: string;
}) {
  return (
    <div className="mt-3.5 flex items-center justify-end gap-2.5">
      {okHint && <span className="mr-auto font-mini text-[10px] text-[var(--ink-dim)]">{okHint}</span>}
      <button onClick={onCancel} className="mac-btn">
        {cancelLabel}
      </button>
      <button onClick={onOk} disabled={okDisabled} className="mac-btn mac-btn-primary">
        {okLabel}
      </button>
    </div>
  );
}

/* ---------------- select：经典 Mac 选择列表（单选 / 多选 / 其他） ---------------- */

function SelectBody({ request, onResolve }: { request: UIDialogRequest } & Pick<Props, "onResolve">) {
  const options = request.options ?? [];
  const multi = request.multiSelect === true;
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");

  const submit = (values: string[]) => {
    const text = custom.trim();
    onResolve(request.id, { values, custom: text === "" ? undefined : text });
  };

  const toggle = (value: string) => {
    setPicked((current) =>
      multi
        ? current.includes(value)
          ? current.filter((item) => item !== value)
          : [...current, value]
        : [value]
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* The free-text box owns its own keys — Space there is a space. */
      if (e.target instanceof HTMLInputElement) {
        if (e.key === "Escape") onResolve(request.id, null);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (i + 1) % options.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i - 1 + options.length) % options.length);
      } else if (e.key === " ") {
        e.preventDefault();
        const option = options[index];
        if (option) toggle(option.value);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const option = options[index];
        /* Single-select: the cursor row is the answer unless something is
           already ticked, so Enter alone is still one keystroke. */
        if (multi) submit(picked);
        else if (picked.length > 0) submit(picked);
        else if (option) submit([option.value]);
      } else if (e.key === "Escape") {
        onResolve(request.id, null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div>
      <div className="border border-[var(--ink)] bg-[var(--chrome-hi)]">
        {options.map((opt, i) => {
          const active = i === index;
          const chosen = picked.includes(opt.value);
          return (
            <button
              key={opt.value}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                /* A click is the whole answer in single-select — unless free
                   text is being typed, where it would drop what was typed. */
                if (!multi && custom.trim() === "") submit([opt.value]);
                else toggle(opt.value);
              }}
              className={`flex w-full items-baseline gap-2 border-b border-[var(--chrome-lo)] px-2.5 py-1.5 text-left last:border-b-0 ${
                active ? "bg-[var(--ink)] text-[var(--chrome-hi)]" : "text-[var(--ink)]"
              }`}
            >
              <span className="w-3 shrink-0 text-[12px]">
                {multi ? (chosen ? "☑" : "☐") : chosen || active ? "●" : "○"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px]">{opt.label}</span>
                {opt.description && (
                  <span className={`block truncate font-mini text-[10px] ${active ? "text-[var(--chrome)]" : "text-[var(--ink-dim)]"}`}>
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {request.allowCustom && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(picked);
            }
          }}
          placeholder="其他（可不填）…"
          className="mt-2 w-full border border-[var(--ink)] bg-[var(--chrome-hi)] px-2.5 py-1.5 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-dim)]"
        />
      )}
      <Footer
        onCancel={() => onResolve(request.id, null)}
        onOk={() => {
          if (picked.length === 0 && custom.trim() === "" && options[index]) submit([options[index].value]);
          else submit(picked);
        }}
        okDisabled={multi && picked.length === 0 && custom.trim() === ""}
        okHint={multi ? "空格勾选 · Enter 提交" : "↑↓ 选择 · Enter 提交"}
      />
    </div>
  );
}

/* ---------------- confirm ---------------- */

function ConfirmBody({ request, onResolve }: { request: UIDialogRequest } & Pick<Props, "onResolve">) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onResolve(request.id, { confirmed: true });
      if (e.key === "Escape") onResolve(request.id, { confirmed: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onResolve, request.id]);

  return (
    <Footer
      onCancel={() => onResolve(request.id, { confirmed: false })}
      onOk={() => onResolve(request.id, { confirmed: true })}
      okLabel={request.okLabel ?? "好"}
      cancelLabel={request.cancelLabel ?? "取消"}
      okHint="Enter 确认 · Esc 取消"
    />
  );
}

/* ---------------- input ---------------- */

function InputBody({ request, onResolve }: { request: UIDialogRequest } & Pick<Props, "onResolve">) {
  const [value, setValue] = useState(request.prefill ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select(); // 预填时全选，直接敲字即覆盖
    }
  }, []);

  return (
    <div>
      <input
        ref={ref}
        type={request.secret ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onResolve(request.id, { value });
          if (e.key === "Escape") onResolve(request.id, null);
        }}
        placeholder={request.placeholder}
        className="w-full border border-[var(--ink)] bg-[var(--chrome-hi)] px-2.5 py-1.5 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-dim)]"
      />
      <Footer
        onCancel={() => onResolve(request.id, null)}
        onOk={() => onResolve(request.id, { value })}
        okDisabled={!request.allowEmpty && !value.trim()}
      />
    </div>
  );
}

/* ---------------- editor ---------------- */

function EditorBody({ request, onResolve }: { request: UIDialogRequest } & Pick<Props, "onResolve">) {
  const [value, setValue] = useState(request.prefill ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, []);

  return (
    <div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onResolve(request.id, { value });
          if (e.key === "Escape") onResolve(request.id, null);
        }}
        rows={7}
        className="w-full resize-y border border-[var(--ink)] bg-[var(--chrome-hi)] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--ink)] outline-none"
      />
      <Footer
        onCancel={() => onResolve(request.id, null)}
        onOk={() => onResolve(request.id, { value })}
        okDisabled={!value.trim()}
        okHint="⌘Enter to submit"
      />
    </div>
  );
}
