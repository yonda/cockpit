// ブラウザ発の書き込み系 API を同一オリジンに限る。
// cockpit は 127.0.0.1 で常駐しているので、別サイトのページが
// fetch(..., {mode:"no-cors"}) で叩けてしまう (CSRF)。pane にテキストを
// 送る API はコマンド実行に直結するため、ここで弾く。
//
// - Sec-Fetch-Site があれば (現行ブラウザは fetch に必ず付ける) same-origin / none だけ通す
// - 無ければ Origin を見て自分のオリジンと一致するときだけ通す
// - どちらも無い (curl 等の非ブラウザ) は通す。ローカル常駐前提の道具なので
//   ブラウザ経由の攻撃だけを塞げばよい
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";

  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
