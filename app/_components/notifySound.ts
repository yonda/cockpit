// Chrome の Web 通知は macOS にサウンドなしで渡されるため、音はページ側で鳴らす。
// 音源は Claude Code hooks 時代と同じ macOS システムサウンド:
//   needsYou (= agent blocked / PR needs-you) → Ping, done → Blow
export function playNotifySound(kind: "needsYou" | "done") {
  try {
    const audio = new Audio(
      kind === "needsYou" ? "/notify-blocked.wav" : "/notify-done.wav",
    );
    audio.volume = 0.6;
    void audio.play().catch(() => {
      /* 自動再生ブロック時は無音のまま */
    });
  } catch {
    /* ignore */
  }
}
