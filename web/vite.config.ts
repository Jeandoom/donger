import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// 端口从项目根 .env 读取（与后端共用一份 .env，需从 web/ 子目录运行 vite）：
//   PORT     后端端口（默认 3300）— 同时决定 dev proxy 目标
//   WEB_PORT 前端 dev 端口（默认 3303）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../", "");
  const backendPort = env.PORT ?? "3300";
  const webPort = Number(env.WEB_PORT) || 3303;
  // 代理目标必须与后端实际监听地址（HOST）一致，否则 ECONNREFUSED。
  // HOST=0.0.0.0（监听通配）或未设置时，回退到 127.0.0.1：0.0.0.0 是监听通配符，
  // 作客户端连接目标不可靠（Windows 上行为不一），用 IPv4 loopback 一定可达。
  // 注意：localhost 在本机常解析为 IPv6 ::1，后端仅绑 IPv4 时会 ECONNREFUSED ::1。
  const backendHost = !env.HOST || env.HOST === "0.0.0.0" ? "127.0.0.1" : env.HOST;
  const backend = `http://${backendHost}:${backendPort}`;
  return {
    plugins: [react()],
    server: {
      // 监听全网卡（0.0.0.0）以支持局域网/远程访问；可经 HOST 覆盖。
      host: env.HOST ?? "0.0.0.0",
      port: webPort,
      // Vite 6.2+ 默认拦截非 localhost 的 Host 头（防 DNS rebinding）。
      // 仅当显式绑 loopback（本机独占）时保留默认保护；其余远程访问场景一律放行。
      allowedHosts:
        env.HOST === "127.0.0.1" || env.HOST === "localhost" ? undefined : true,
      proxy: {
        "/api": backend,
        "/ws": { target: backend.replace("http", "ws"), ws: true },
      },
    },
    build: { outDir: "dist" },
  };
});
