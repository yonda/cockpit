// tier 見出し直下に置くコンパクトな空表示 (Asking/Working と Now/Soon/Hold で共通)
export function EmptyRow({ message }: { message: string }) {
  return (
    <div className="border border-dashed border-[var(--hairline)] px-6 py-4 text-center font-mono text-[11px] uppercase tracking-widest text-[var(--ink-muted)]">
      — {message} —
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="border border-dashed border-[var(--hairline)] px-6 py-10 text-center">
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
        — status ok —
      </div>
      <div className="mt-2 font-mono text-[14px] font-medium text-[var(--ink-dim)]">
        {message}
      </div>
    </div>
  );
}
