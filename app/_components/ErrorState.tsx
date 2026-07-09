import { AlertOctagon, WifiOff } from "lucide-react";
import type { ReactNode } from "react";

// undici / Node のネットワークレベル失敗コード。これらは「GitHub 側の問題」
// ではなく「こちらのネットワークが落ちている」ことを意味する（スリープ復帰直後など）
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function findNetworkCause(err: unknown, depth = 0): Error | null {
  if (!(err instanceof Error) || depth > 5) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return err;
  return findNetworkCause(err.cause, depth + 1);
}

export function isNetworkError(err: unknown): boolean {
  if (findNetworkCause(err)) return true;
  return err instanceof TypeError && err.message === "fetch failed";
}

type ErrorStateProps = {
  message: string;
  title?: string;
  hint?: string;
  variant?: "fault" | "offline";
  action?: ReactNode;
};

export function ErrorState({
  message,
  title = "fault · load failed",
  hint,
  variant = "fault",
  action,
}: ErrorStateProps) {
  const color =
    variant === "offline" ? "var(--signal-warn)" : "var(--signal-alert)";
  const Icon = variant === "offline" ? WifiOff : AlertOctagon;

  return (
    <div
      className="flex items-start gap-3 border px-4 py-3"
      style={{
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 5%, transparent)`,
      }}
    >
      <Icon size={16} className="mt-0.5 shrink-0" style={{ color }} />
      <div className="flex-1">
        <p className="font-mono-caps text-[10px]" style={{ color }}>
          {title}
        </p>
        <p className="mt-1 font-mono text-[11px] text-[var(--ink-dim)]">
          {message}
        </p>
        {hint ? (
          <p className="mt-1 font-mono text-[11px] text-[var(--ink-muted)]">
            {hint}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Server Component の fetch エラー用。throw せずにこれをレンダリングして返すと、
 * エラー UI が通常のレンダリング結果になるため本番でもメッセージがマスクされず、
 * RefreshButton の 15 秒ポーリング (router.refresh) が成功した時点で自動復帰する。
 */
export function SectionErrorState({ error }: { error: unknown }) {
  const err = error instanceof Error ? error : new Error(String(error));

  if (isNetworkError(err)) {
    const cause = findNetworkCause(err);
    return (
      <ErrorState
        variant="offline"
        title="offline · network unreachable"
        message={cause?.message ?? err.message}
        hint="auto-reconnects every 15s · no action needed"
      />
    );
  }

  if (err.name === "GitHubApiError") {
    return (
      <ErrorState
        title="fault · github api error"
        message={err.message}
        hint="auto-retrying every 15s"
      />
    );
  }

  return <ErrorState message={err.message} hint="auto-retrying every 15s" />;
}
