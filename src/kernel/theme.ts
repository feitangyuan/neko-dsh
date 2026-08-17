/**
 * Theme application.
 *
 * The preference itself lives in dsh's `ui-theme` settings namespace, but the
 * plugin that consumes it (`packages/client/ui-theme`) drives dsh's own
 * `--dsw-*` stylesheets and is not loaded here. Our shell reads the same stored
 * value and applies it to the `[data-theme]` tokens in globals.css instead, so
 * the setting survives restarts and stays in one place.
 */

export type ThemePreference = "light" | "dark" | "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";

let media: MediaQueryList | null = null;
let followSystem: (() => void) | null = null;

/** Normalise anything the settings document holds into the three known states. */
export function asPreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function paint(theme: "light" | "dark"): "light" | "dark" {
  document.documentElement.dataset.theme = theme;
  return theme;
}

/**
 * Apply a stored preference, resolving `system` live.
 *
 * Idempotent: the system listener is attached only while `system` is in effect
 * and torn down on any other value, so repeated calls cannot stack listeners.
 * `onResolve` is called for this application and again whenever the OS flips
 * under a `system` preference.
 *
 * Single writer: nothing else may set `data-theme`, or the two owners fight.
 */
export function applyThemePreference(
  preference: ThemePreference,
  onResolve?: (theme: "light" | "dark") => void
): "light" | "dark" {
  if (media && followSystem) {
    media.removeEventListener("change", followSystem);
    followSystem = null;
  }
  if (preference !== "system") {
    onResolve?.(paint(preference));
    return preference;
  }
  media ??= window.matchMedia(DARK_QUERY);
  followSystem = () => onResolve?.(paint(media?.matches === true ? "dark" : "light"));
  media.addEventListener("change", followSystem);
  const resolved = paint(media.matches ? "dark" : "light");
  onResolve?.(resolved);
  return resolved;
}
