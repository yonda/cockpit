"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "cockpit:theme";

type Theme = "dark" | "light";

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

// <html data-theme> は layout の inline script が描画前に復元する。
// このコンポーネントは切り替えと永続化だけを担う。
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode 等は無視 */
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え"}
      className="group inline-flex items-center border border-[var(--hairline-strong)] bg-[var(--background-elevated)] px-2.5 py-1.5 text-[var(--ink-dim)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  );
}
