import { writable } from "svelte/store";

const THEME_KEY = "noah-theme";

export type ThemePref = "system" | "light" | "dark";
/** The theme actually in effect — "system" already resolved against the OS. */
export type ResolvedTheme = "light" | "dark";

const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function getThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? (media?.matches ? "dark" : "light") : pref;
}

/** The theme in effect right now, for one-shot imperative reads. */
export function currentTheme(): ResolvedTheme {
  if (typeof document === "undefined") return resolve(getThemePref());
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const resolvedTheme = writable<ResolvedTheme>(currentTheme());

/**
 * Resolved theme as a subscribable store. Canvas-style renderers (cytoscape,
 * Vega, mermaid) read their colors imperatively at build time, so a `data-theme`
 * flip alone leaves them stranded on the old palette — they subscribe here and
 * re-derive. `applyTheme` is the single writer.
 */
export const theme = { subscribe: resolvedTheme.subscribe };

/**
 * A design-token value resolved against the theme in effect — e.g.
 * `cssToken("--accent")` → "#0f766e". Custom properties are substituted in the
 * computed style, so the `var()` chains resolve; `fallback` covers a context
 * with no stylesheet loaded. For canvas/chart renderers that need a real color
 * string instead of a CSS reference.
 */
export function cssToken(name: string, fallback = ""): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function applyTheme(pref = getThemePref()): ThemePref {
  const resolved = resolve(pref);
  document.documentElement.dataset.theme = resolved;
  resolvedTheme.set(resolved);
  return pref;
}

function applyThemeWithTransition(pref: ThemePref): void {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const documentWithTransitions = document as Document & {
    startViewTransition?: (update: () => void) => { finished: Promise<void> };
  };
  if (!reduced && documentWithTransitions.startViewTransition) {
    documentWithTransitions.startViewTransition(() => applyTheme(pref));
    return;
  }
  if (!reduced) {
    document.documentElement.classList.add("theme-changing");
    window.setTimeout(() => document.documentElement.classList.remove("theme-changing"), 220);
  }
  applyTheme(pref);
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  applyThemeWithTransition(pref);
}

export function watchSystemTheme(): void {
  media?.addEventListener?.("change", () => {
    if (getThemePref() === "system") applyThemeWithTransition("system");
  });
}
