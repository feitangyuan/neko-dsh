/**
 * Preferences the shell owns.
 *
 * dsh's settings document is schema-locked per namespace — `settings.mutate`
 * validates every write against the schema the owning plugin registered, so a
 * key dsh never declared cannot be stored there. Theme is a dsh setting
 * (`ui-theme`) and stays one; these three describe this window, which dsh has
 * no concept of, so they live in local storage instead.
 */

const FONT_SIZE_KEY = "neko.fontSize";
const START_DIR_KEY = "neko.startDir";
const NOTIFY_KEY = "neko.notifyOnIdle";

/**
 * The app was called `dsh-gui` before it was called Neko. Read through to the
 * old key once so a rename does not silently reset someone's window.
 */
function read(key: string): string | null {
  const value = localStorage.getItem(key);
  if (value !== null) return value;
  const legacy = localStorage.getItem(key.replace(/^neko\./, "dsh-gui."));
  if (legacy !== null) localStorage.setItem(key, legacy);
  return legacy;
}

/** Rendered size of 12px body text. The pixel face is a 12px bitmap, so the
 *  steps are its whole multiples-ish — 14 is tight, 20 is a magnifier. */
export const FONT_SIZES = [14, 16, 18, 20] as const;
export const DEFAULT_FONT_SIZE = 16;

export function readFontSize(): number {
  const stored = Number(read(FONT_SIZE_KEY));
  return FONT_SIZES.includes(stored as (typeof FONT_SIZES)[number]) ? stored : DEFAULT_FONT_SIZE;
}

export function writeFontSize(size: number) {
  localStorage.setItem(FONT_SIZE_KEY, String(size));
}

/** Paint one size onto the two variables globals.css maps 12px/10px onto. */
export function applyFontSize(size: number) {
  const root = document.documentElement.style;
  root.setProperty("--ui-font-size", `${size}px`);
  root.setProperty("--ui-mini-font-size", `${Math.max(10, size - 2)}px`);
}

/** Where 新建会话 starts. Empty = wherever the runtime process sits (the user's home). */
export function readStartDir(): string {
  return read(START_DIR_KEY) ?? "";
}

export function writeStartDir(path: string) {
  if (path === "") localStorage.removeItem(START_DIR_KEY);
  else localStorage.setItem(START_DIR_KEY, path);
}

/** Notify when a turn lands while the window is in the background. */
export function readNotifyOnIdle(): boolean {
  return read(NOTIFY_KEY) !== "off";
}

export function writeNotifyOnIdle(on: boolean) {
  localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
}
