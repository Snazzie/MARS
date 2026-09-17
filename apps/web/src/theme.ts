import { useEffect, useState } from "react";

export const themeOptions = [
  { id: "default", label: "Default" },
  { id: "martian", label: "Martian" },
] as const;

export type ThemeId = (typeof themeOptions)[number]["id"];
const storageKey = "mars.theme";
const changeEvent = "mars-theme-change";

function readTheme(): ThemeId {
  try {
    return localStorage.getItem(storageKey) === "martian" ? "martian" : "default";
  } catch {
    return "default";
  }
}

export function applyTheme(theme: ThemeId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(readTheme);
  useEffect(() => {
    const sync = () => setThemeState(readTheme());
    window.addEventListener(changeEvent, sync);
    return () => window.removeEventListener(changeEvent, sync);
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  function setTheme(next: ThemeId) {
    setThemeState(next);
    applyTheme(next);
    try { localStorage.setItem(storageKey, next); } catch { /* storage can be disabled */ }
    window.dispatchEvent(new Event(changeEvent));
  }
  return { theme, setTheme };
}

if (typeof document !== "undefined") applyTheme(readTheme());
