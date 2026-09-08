"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Crosshair, Send } from "lucide-react";
import type { HerdrPane, HerdrStatus, HerdrWorkspace } from "@/lib/herdr/types";
import {
  buildHerdrTree,
  defaultSelectedPaneId,
  flattenPaneIds,
  paneShortId,
  type HerdrTreeTab,
  type HerdrTreeWorkspace,
} from "@/lib/herdr/tree";
import { StatusPill } from "./PaneCard";
import { ErrorState } from "./ErrorState";
import { EmptyRow } from "./EmptyState";
import { SectionSkeleton } from "./Skeleton";
import { useHerdrContext, LiveIndicator } from "./useHerdrState";

// 画面テキストの取り直し間隔。herdr の SSE は状態変化しか流さないので、
// 出力の流れは自前で見に行く。
const SCREEN_POLL_MS = 2_500;
const SCREEN_LINES = 80;

type ScreenSource = "recent" | "visible";

const STATUS_DOT: Record<HerdrStatus, string> = {
  working: "bg-[var(--signal-info)]",
  blocked: "bg-[var(--signal-alert)]",
  done: "bg-[var(--signal-ok)]",
  idle: "bg-[var(--signal-idle)]",
  unknown: "bg-[var(--ink-faint)]",
};

function paneTitle(pane: HerdrPane): string | null {
  return pane.title ?? pane.recap?.title ?? pane.terminalTitle ?? null;
}

function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable
  );
}

// ---------------------------------------------------------------- 左列: 木

function PaneRow({
  pane,
  selected,
  onSelect,
}: {
  pane: HerdrPane;
  selected: boolean;
  onSelect: (paneId: string) => void;
}) {
  const title = paneTitle(pane);
  return (
    <button
      type="button"
      onClick={() => onSelect(pane.paneId)}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-start gap-2 border-l-2 py-1.5 pr-2 pl-3 text-left transition ${
        selected
          ? "border-[var(--accent)] bg-[var(--accent)]/8"
          : "border-transparent hover:bg-[var(--panel-hover)]"
      }`}
    >
      <span
        className={`mt-[6px] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
          STATUS_DOT[pane.agent ? pane.agentStatus : "unknown"]
        }`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 font-mono text-[11px]">
          <span className="text-[var(--ink-muted)]">{paneShortId(pane.paneId)}</span>
          <span
            className={
              pane.agent ? "font-medium text-[var(--ink)]" : "text-[var(--ink-faint)]"
            }
          >
            {pane.agent ?? "shell"}
          </span>
          {pane.focused ? (
            <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--accent)]">
              · focused
            </span>
          ) : null}
        </span>
        {title ? (
          <span
            className="truncate text-[12px] leading-snug text-[var(--ink-dim)]"
            title={title}
          >
            {title}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function TabBlock({
  node,
  showHeader,
  selectedId,
  onSelect,
}: {
  node: HerdrTreeTab;
  showHeader: boolean;
  selectedId: string | null;
  onSelect: (paneId: string) => void;
}) {
  const label = node.tab?.label ?? paneShortId(node.tabId);
  return (
    <div className="flex flex-col">
      {showHeader ? (
        <div className="flex items-center gap-2 py-1 pl-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
          <span>tab {label}</span>
          {node.tab?.focused ? <span className="text-[var(--accent)]">·</span> : null}
        </div>
      ) : null}
      {node.panes.length === 0 ? (
        <div className="py-1 pl-6 font-mono text-[10px] text-[var(--ink-faint)]">
          no panes
        </div>
      ) : (
        node.panes.map((pane) => (
          <PaneRow
            key={pane.paneId}
            pane={pane}
            selected={pane.paneId === selectedId}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

function WorkspaceBlock({
  node,
  selectedId,
  onSelect,
}: {
  node: HerdrTreeWorkspace;
  selectedId: string | null;
  onSelect: (paneId: string) => void;
}) {
  const { workspace, tabs } = node;
  // tab が 1 つで既定名 ("1") のままなら、herdr 同様に tab 行を出さない
  const showTabHeaders =
    tabs.length > 1 ||
    tabs.some((t) => t.tab && t.tab.label !== String(t.tab.number));
  return (
    <section className="flex flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--hairline)] py-1.5 pr-2">
        <span className="w-5 text-right font-mono text-[11px] text-[var(--ink-muted)]">
          {workspace.number < Number.MAX_SAFE_INTEGER ? workspace.number : "·"}
        </span>
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[workspace.agentStatus]}`}
        />
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[12px] font-semibold uppercase tracking-[0.08em] ${
            workspace.focused ? "text-[var(--accent)]" : "text-[var(--ink)]"
          }`}
          title={workspace.label}
        >
          {workspace.label}
        </span>
        {workspace.worktree?.isLinkedWorktree ? (
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            wt
          </span>
        ) : null}
      </header>
      <div className="flex flex-col py-1">
        {tabs.map((t) => (
          <TabBlock
            key={t.tabId}
            node={t}
            showHeader={showTabHeaders}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function HerdrTree({
  tree,
  selectedId,
  onSelect,
}: {
  tree: HerdrTreeWorkspace[];
  selectedId: string | null;
  onSelect: (paneId: string) => void;
}) {
  return (
    <nav
      aria-label="herdr workspaces"
      className="flex flex-col gap-3 border border-[var(--hairline)] bg-[var(--background)] p-2"
    >
      {tree.map((node) => (
        <WorkspaceBlock
          key={node.workspace.workspaceId}
          node={node}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </nav>
  );
}

// ------------------------------------------------------------ 右列: 詳細

type ScreenResult =
  | { status: "loading" }
  | {
      status: "ok";
      text: string;
      truncated: boolean;
      branch: string | null;
      fetchedAt: number;
    }
  | { status: "error"; message: string };

// pane オブジェクトは herdr の状態が更新されるたび (SSE → refetch) に
// 作り直されるので、その参照変化を「画面を取り直す合図」に使う。
function useScreen(paneId: string, source: ScreenSource, pane: HerdrPane) {
  const [screen, setScreen] = useState<ScreenResult>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(load, SCREEN_POLL_MS);
        return;
      }
      try {
        const res = await fetch(
          `/api/herdr/panes/${encodeURIComponent(paneId)}?source=${source}&lines=${SCREEN_LINES}`,
          { cache: "no-store" },
        );
        const body = (await res.json()) as
          | {
              ok: true;
              branch: string | null;
              screen: { text: string; truncated: boolean };
            }
          | { ok: false; error: string };
        if (cancelled) return;
        if (body.ok) {
          setScreen({
            status: "ok",
            text: body.screen.text,
            truncated: body.screen.truncated,
            branch: body.branch,
            fetchedAt: Date.now(),
          });
        } else {
          setScreen((prev) =>
            prev.status === "ok" ? prev : { status: "error", message: body.error },
          );
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "failed to read pane";
        setScreen((prev) => (prev.status === "ok" ? prev : { status: "error", message }));
      }
      if (!cancelled) timer = setTimeout(load, SCREEN_POLL_MS);
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [paneId, source, pane, nonce]);

  return { screen, refresh };
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 border border-[var(--hairline)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-dim)]">
      <span className="text-[var(--ink-muted)]">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function ScreenView({ screen }: { screen: ScreenResult }) {
  const preRef = useRef<HTMLPreElement>(null);
  // 末尾に張り付いているときだけ更新後も末尾へ送る。
  // 上へスクロールして読んでいる最中は位置を保つ。
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
  };

  const text = screen.status === "ok" ? screen.text : "";
  useEffect(() => {
    const el = preRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  if (screen.status === "loading") return <SectionSkeleton />;
  if (screen.status === "error") {
    return <ErrorState title="fault · pane read failed" message={screen.message} />;
  }
  return (
    <pre
      ref={preRef}
      onScroll={onScroll}
      className="max-h-[60vh] min-h-[240px] overflow-auto whitespace-pre-wrap break-words bg-[var(--panel)] p-3 font-mono text-[11.5px] leading-[1.45] text-[var(--ink-dim)]"
    >
      {screen.text.replace(/^\n+/, "") || (
        <span className="text-[var(--ink-faint)]">(empty screen)</span>
      )}
    </pre>
  );
}

function PromptForm({
  paneId,
  isAgent,
  onSent,
}: {
  paneId: string;
  isAgent: boolean;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const body = text.trim();
    if (!body || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/herdr/panes/${encodeURIComponent(paneId)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? "failed to send");
        return;
      }
      setText("");
      // 送った直後の画面を取り直す (agent が受け取ったか目で確認できる)
      setTimeout(onSent, 400);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to send");
    } finally {
      setPending(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter で送信、Shift+Enter で改行。IME 変換中の Enter は無視する
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2 border border-[var(--hairline-strong)] bg-[var(--background-elevated)] px-2 py-1.5 focus-within:border-[var(--accent)]">
        <span className="pb-1 font-mono text-[12px] text-[var(--accent)]">›</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={isAgent ? "prompt to this agent" : "command for this shell"}
          disabled={pending}
          className="max-h-40 min-h-[24px] flex-1 resize-y bg-transparent font-mono text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
        />
        <button
          type="submit"
          disabled={pending || text.trim() === ""}
          title="send (Enter)"
          className="inline-flex items-center gap-1 border border-[var(--hairline-strong)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
        >
          <Send size={11} />
          send
        </button>
      </div>
      {error ? (
        <div className="font-mono text-[10px] text-[var(--signal-alert)]">{error}</div>
      ) : null}
    </form>
  );
}

function PaneDetail({
  pane,
  workspace,
}: {
  pane: HerdrPane;
  workspace: HerdrWorkspace | null;
}) {
  const [source, setSource] = useState<ScreenSource>("recent");
  const { screen, refresh } = useScreen(pane.paneId, source, pane);
  const [focusPending, setFocusPending] = useState(false);

  const title = paneTitle(pane);
  const displayCwd = pane.foregroundCwd ?? pane.cwd;
  const branch = screen.status === "ok" ? screen.branch : null;
  const tokens = Object.entries(pane.tokens);
  const labels = Object.entries(pane.stateLabels);

  const focus = async () => {
    if (focusPending) return;
    setFocusPending(true);
    try {
      await fetch("/api/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: pane.workspaceId,
          tabId: pane.tabId,
          paneId: pane.paneId,
        }),
      });
    } catch {
      /* ignore */
    } finally {
      setFocusPending(false);
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-3 border border-[var(--hairline)] bg-[var(--background)] p-3">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            {workspace?.label ?? pane.workspaceId} / {paneShortId(pane.paneId)}
          </span>
          <span className="font-mono text-[12px] font-medium text-[var(--ink)]">
            {pane.agent ?? "shell"}
          </span>
          <StatusPill status={pane.agent ? pane.agentStatus : "unknown"} />
          <span className="flex-1" />
          <button
            type="button"
            onClick={focus}
            disabled={focusPending}
            title="herdr でこの pane を開く"
            className="inline-flex items-center gap-1 border border-[var(--hairline-strong)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60"
          >
            <Crosshair size={11} />
            focus
          </button>
        </div>
        {title ? (
          <div className="text-[14px] font-semibold leading-snug text-[var(--ink)]">
            {title}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip label="cwd" value={displayCwd} />
          {branch ? <Chip label="branch" value={branch} /> : null}
          {labels.map(([k, v]) => (
            <Chip key={`label-${k}`} label={k} value={v} />
          ))}
          {tokens.map(([k, v]) => (
            <Chip key={`tok-${k}`} label={k} value={v} />
          ))}
        </div>
        {pane.recap?.lastPrompt ? (
          <div
            className="truncate font-mono text-[11px] text-[var(--ink-dim)]"
            title={pane.recap.lastPrompt}
          >
            <span className="text-[var(--accent)]">› </span>
            {pane.recap.lastPrompt}
          </div>
        ) : null}
      </header>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em]">
          {(["recent", "visible"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              className={`px-1.5 py-0.5 transition ${
                source === s
                  ? "text-[var(--accent)]"
                  : "text-[var(--ink-muted)] hover:text-[var(--ink-dim)]"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {screen.status === "ok" ? (
          <span className="font-mono text-[10px] text-[var(--ink-faint)]">
            {screen.truncated ? "truncated · " : ""}
            {new Date(screen.fetchedAt).toLocaleTimeString("ja-JP", { hour12: false })}
          </span>
        ) : null}
      </div>

      <ScreenView screen={screen} />

      <PromptForm paneId={pane.paneId} isAgent={Boolean(pane.agent)} onSent={refresh} />
    </section>
  );
}

// ---------------------------------------------------------------- 全体

export function HerdrMirror() {
  const { result, live } = useHerdrContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const state = result.status === "ok" ? result.state : null;
  const tree = useMemo(() => (state ? buildHerdrTree(state) : []), [state]);
  const paneIds = useMemo(() => flattenPaneIds(tree), [tree]);

  const effectiveId =
    selectedId && paneIds.includes(selectedId)
      ? selectedId
      : defaultSelectedPaneId(tree);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      const delta =
        event.key === "j" || event.key === "ArrowDown"
          ? 1
          : event.key === "k" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (delta === 0 || paneIds.length === 0) return;
      event.preventDefault();
      const idx = effectiveId ? paneIds.indexOf(effectiveId) : -1;
      const next = paneIds[(idx + delta + paneIds.length) % paneIds.length];
      setSelectedId(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paneIds, effectiveId]);

  if (result.status === "loading") return <SectionSkeleton />;
  if (result.status === "error") return <ErrorState message={result.message} />;

  const selectedPane = state?.panes.find((p) => p.paneId === effectiveId) ?? null;
  const selectedWorkspace = selectedPane
    ? (state?.workspaces.find((w) => w.workspaceId === selectedPane.workspaceId) ?? null)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="self-end">
        <LiveIndicator live={live} />
      </div>
      {tree.length === 0 ? (
        <EmptyRow message="herdr has no workspaces" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <HerdrTree tree={tree} selectedId={effectiveId} onSelect={setSelectedId} />
          {selectedPane ? (
            <PaneDetail
              key={selectedPane.paneId}
              pane={selectedPane}
              workspace={selectedWorkspace}
            />
          ) : (
            <EmptyRow message="select a pane" />
          )}
        </div>
      )}
    </div>
  );
}
