import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "proxytail-theme";
const listeners = new Set<() => void>();
const media = matchMedia("(prefers-color-scheme: dark)");

function current(): Theme {
  const t = localStorage.getItem(KEY);
  return t === "light" || t === "dark" ? t : "system";
}

function resolved(theme = current()): "light" | "dark" {
  return theme === "system" ? (media.matches ? "dark" : "light") : theme;
}

function apply() {
  document.documentElement.classList.toggle("dark", resolved() === "dark");
  listeners.forEach((l) => l());
}

apply();
media.addEventListener("change", apply);

export function setTheme(theme: Theme) {
  if (theme === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, theme);
  apply();
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
  );
  return { theme, resolvedTheme: resolved(theme), setTheme };
}
