import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// 端口从项目根 .env 读取（与后端共用一份 .env，需从 web/ 子目录运行 vite）：
//   PORT     后端端口（默认 3300）— 同时决定 dev proxy 目标
//   WEB_PORT 前端 dev 端口（默认 3303）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../", "");
  const backendPort = env.PORT ?? "3300";
  const webPort = Number(env.WEB_PORT) || 3303;
  // 用 127.0.0.1（IPv4 loopback）而非 localhost：后端默认绑 0.0.0.0（仅 IPv4），
  // localhost 在本机常解析为 IPv6 ::1，会导致代理 ECONNREFUSED ::1:3300。
  const backend = `http://127.0.0.1:${backendPort}`;
  return {
    plugins: [react()],
    server: {
      // 监听全网卡（0.0.0.0）以支持局域网/远程访问；可经 HOST 覆盖。
      host: env.HOST ?? "0.0.0.0",
      port: webPort,
      proxy: {
        "/api": backend,
        "/ws": { target: backend.replace("http", "ws"), ws: true },
      },
    },
    build: { outDir: "dist" },
  };
});
