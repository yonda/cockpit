import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Manrope } from "next/font/google";
import { Header } from "./_components/Header";
import { HerdrProvider } from "./_components/useHerdrState";
import { AgentNotifyWatcher } from "./_components/AgentNotifyWatcher";
import { BusyStatusDialog } from "./_components/BusyStatusDialog";
import { fetchViewerStatus } from "@/lib/github/fetchers";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
});

export const metadata: Metadata = {
  title: "cockpit",
  description: "Personal GitHub PR dashboard",
  applicationName: "cockpit",
  appleWebApp: {
    capable: true,
    title: "cockpit",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0d12",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 取得失敗でアプリ全体を巻き込まない (busy 検知はベストエフォート)
  const viewerStatus = await fetchViewerStatus().catch(() => null);
  return (
    <html
      lang="ja"
      className={`${manrope.variable} ${jetbrainsMono.variable} h-full antialiased`}
      data-theme="dark"
    >
      <body className="min-h-full flex flex-col overflow-x-clip">
        {/* 描画前に保存済みテーマを復元して FOUC を防ぐ */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("cockpit:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
        {/* herdr の SSE 接続をアプリ全体で 1 本共有し、どのタブにいても agent 通知を出す */}
        <HerdrProvider>
          <AgentNotifyWatcher />
          <BusyStatusDialog status={viewerStatus} />
          <Header />
          {children}
        </HerdrProvider>
      </body>
    </html>
  );
}
