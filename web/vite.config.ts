import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// 端口从项目根 .env 读取（与后端共用一份 .env，需从 web/ 子目录运行 vite）：
//   PORT     后端端口（默认 3300）— 同时决定 dev proxy 目标
//   WEB_PORT 前端 dev 端口（默认 3303）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../", "");
  const backendPort = env.PORT ?? "3300";
  const webPort = Number(env.WEB_PORT) || 3303;
  const backend = `http://localhost:${backendPort}`;
  return {
    plugins: [react()],
    server: {
      port: webPort,
      proxy: {
        "/api": backend,
        "/ws": { target: backend.replace("http", "ws"), ws: true },
      },
    },
    build: { outDir: "dist" },
  };
});
