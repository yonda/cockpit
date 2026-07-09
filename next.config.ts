import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  experimental: {
    // Turbopack のデフォルト 'childProcesses' は PostCSS transform を
    // 子プロセス pool で実行し、高負荷時に spawn が雪だるま式に増える
    // (実測: ブラウザの並行リクエストで 2000+ プロセス、load avg 900)。
    // worker threads なら同一プロセス内で完結するため fork 爆発が起きない。
    turbopackPluginRuntimeStrategy: "workerThreads",
  },
};

export default nextConfig;
