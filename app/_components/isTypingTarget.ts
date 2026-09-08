// テキスト入力中はページ全体のキーボードショートカットを奪わない。
// KeyboardNav (数字キー) と HerdrMirror (j/k) が共通で使う。
export function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}
