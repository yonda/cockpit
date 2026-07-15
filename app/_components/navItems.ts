// ボードの単一の真実。表示順がそのままキーボードショートカット (1〜4) に対応する。
// NavTabs (表示) と KeyboardNav (キー操作) の双方がここを参照し、定義の二重化を防ぐ。
export const NAV = [
  { href: "/", label: "Board" },
  { href: "/pull-requests", label: "PRs" },
  { href: "/wip", label: "WIP" },
  { href: "/activity", label: "Activity" },
  { href: "/progress", label: "Progress" },
] as const;
