const THEME_KEY = "noah-theme";

export type ThemePref = "system" | "light" | "dark";

const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function getThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref = getThemePref()): ThemePref {
  const resolved = pref === "system" ? (media?.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
  return pref;
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}

export function watchSystemTheme(): void {
  media?.addEventListener?.("change", () => {
    if (getThemePref() === "system") applyTheme("system");
  });
}
