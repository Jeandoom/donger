import type { VitePWAOptions } from "vite-plugin-pwa";

export const PWA_OPTIONS: Partial<VitePWAOptions> = {
  registerType: "prompt",
  includeAssets: [
    "favicon.ico",
    "apple-touch-icon-180x180.png",
    "pwa-192x192.png",
    "pwa-512x512.png",
    "maskable-icon-512x512.png",
  ],
  manifest: {
    name: "donger",
    short_name: "donger",
    description: "技能驱动的本地自动化 Agent",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#111827",
    background_color: "#111827",
    icons: [
      { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/maskable-icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  },
  workbox: {
    cleanupOutdatedCaches: true,
    globPatterns: ["**/*.{html,js,css,ico,png,svg,woff2}"],
    navigateFallback: "index.html",
    // denylist 必含 /apps/：应用 bundle 的导航不能被 SPA fallback 劫持回主站 index.html
    navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//, /^\/apps\//, /\/stream(?:\?|$)/],
    runtimeCaching: [],
  },
};
