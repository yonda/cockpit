"use client";

import { unstable_catchError, type ErrorInfo } from "next/error";
import { ErrorState } from "./ErrorState";

// fetch 起因のエラーはサーバー側で catch して SectionErrorState を返すため、
// ここに到達するのは想定外のレンダリングバグのみ。unstable_retry() は
// 再フェッチ付きで再レンダリングするので、一時的なバグからも復帰できる。
function SectionFallback(
  { title }: { title: string },
  { error, unstable_retry }: ErrorInfo,
) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ErrorState
        title="fault · render failed"
        message={error.message}
        action={
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="shrink-0 border border-[var(--hairline-strong)] bg-[var(--background-elevated)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            retry ↻
          </button>
        }
      />
    </section>
  );
}

export const SectionBoundary = unstable_catchError(SectionFallback);
