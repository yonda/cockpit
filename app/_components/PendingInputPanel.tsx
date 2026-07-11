"use client";

import { useState } from "react";
import type { Job, PendingInput } from "@/lib/jobs/types";

/** permission の内容を人間が判断できる 1 行に要約する */
function summarizeInput(pending: PendingInput): string {
  const input = pending.input as Record<string, unknown> | null;
  if (pending.toolName === "Bash" && typeof input?.command === "string") {
    return input.command;
  }
  if (typeof input?.file_path === "string") return input.file_path;
  return JSON.stringify(input).slice(0, 300);
}

type QuestionInput = {
  questions?: Array<{
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

type Question = NonNullable<QuestionInput["questions"]>[number];

function QuestionPanel({
  questions,
  busy,
  error,
  respond,
}: {
  questions: Question[];
  busy: boolean;
  error: string | null;
  respond: (response: unknown) => void;
}) {
  const [selections, setSelections] = useState<string[][]>(() =>
    questions.map(() => []),
  );

  const toggle = (qIndex: number, label: string, multiSelect: boolean) => {
    setSelections((prev) =>
      prev.map((selected, i) => {
        if (i !== qIndex) return selected;
        if (!multiSelect) {
          return selected.includes(label) ? [] : [label];
        }
        return selected.includes(label)
          ? selected.filter((l) => l !== label)
          : [...selected, label];
      }),
    );
  };

  const allAnswered =
    questions.length > 0 && selections.every((s) => s.length > 0);

  return (
    <div className="flex flex-col gap-3 border border-[var(--signal-alert)]/40 bg-[var(--signal-alert)]/5 p-3">
      {questions.map((q, qIndex) => (
        <div key={`${qIndex}-${q.question}`} className="flex flex-col gap-2">
          <div className="text-[13px] font-semibold text-[var(--ink)]">
            {q.question}
          </div>
          <div className="flex flex-wrap gap-2">
            {(q.options ?? []).map((option) => {
              const selected = selections[qIndex]?.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={busy}
                  title={option.description}
                  onClick={() => toggle(qIndex, option.label, q.multiSelect ?? false)}
                  className={`border px-2.5 py-1 font-mono text-[12px] transition ${
                    selected
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "border-[var(--hairline-strong)] text-[var(--ink)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div>
        <button
          type="button"
          disabled={busy || !allAnswered}
          onClick={() => respond({ kind: "answers", answers: selections })}
          className="border border-[var(--accent)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--accent)] transition hover:bg-[var(--accent)]/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          回答を送信
        </button>
      </div>
      {error ? (
        <div className="font-mono text-[11px] text-[var(--signal-alert)]">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function PendingInputPanel({ job }: { job: Job }) {
  const pending = job.pendingInput!;
  const [busy, setBusy] = useState(false);
  const [denyMessage, setDenyMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const respond = async (response: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputId: pending.id, response }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) setError(json.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  if (pending.kind === "question") {
    const questions = (pending.input as QuestionInput).questions ?? [];
    return <QuestionPanel questions={questions} busy={busy} error={error} respond={respond} />;
  }

  return (
    <div className="flex flex-col gap-2 border border-[var(--signal-alert)]/40 bg-[var(--signal-alert)]/5 p-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--signal-alert)]">
        permission · {pending.toolName}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] text-[var(--ink)]">
        {summarizeInput(pending)}
      </pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => respond({ kind: "allow" })}
          className="border border-[var(--signal-ok)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--signal-ok)] transition hover:bg-[var(--signal-ok)]/10"
        >
          許可
        </button>
        <input
          value={denyMessage}
          onChange={(e) => setDenyMessage(e.target.value)}
          placeholder="拒否理由 (任意)"
          aria-label="拒否理由"
          className="min-w-0 flex-1 border border-[var(--hairline)] bg-transparent px-2 py-1 font-mono text-[12px] text-[var(--ink)]"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            respond({ kind: "deny", message: denyMessage || "拒否されました" })
          }
          className="border border-[var(--signal-alert)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--signal-alert)] transition hover:bg-[var(--signal-alert)]/10"
        >
          拒否
        </button>
      </div>
      {error ? (
        <div className="font-mono text-[11px] text-[var(--signal-alert)]">
          {error}
        </div>
      ) : null}
    </div>
  );
}
