"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { NAV } from "./navItems";

// 数字キー 1〜6 で NAV の該当ボードへ遷移する。PWA を全画面常駐で使うため、
// マウスに手を伸ばさずタブを移動できるようにする。
export function KeyboardNav() {
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 修飾キー併用時 (Cmd/Ctrl/Alt) はブラウザ標準操作を尊重して無視する
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const position = Number(event.key);
      if (!Number.isInteger(position) || position < 1 || position > NAV.length) {
        return;
      }

      // テキスト入力中はショートカットを奪わない
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        const tag = active.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          active.isContentEditable
        ) {
          return;
        }
      }

      event.preventDefault();
      router.push(NAV[position - 1].href);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return null;
}
