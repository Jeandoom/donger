import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { PWA_OPTIONS } from "./pwa.config";

// 端口从项目根 .env 读取（与后端共用一份 .env，需从 web/ 子目录运行 vite）：
//   PORT     后端端口（默认 3330）— 同时决定 dev proxy 目标
//   WEB_PORT 前端 dev 端口（默认 3333）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../", "");
  const backendPort = env.PORT ?? "3330";
  const webPort = Number(env.WEB_PORT) || 3333;
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const certPath = env.HTTPS_CERT_PATH?.trim();
  const keyPath = env.HTTPS_KEY_PATH?.trim();
  const chainPath = env.HTTPS_CHAIN_PATH?.trim();
  if ((certPath && !keyPath) || (!certPath && keyPath) || (chainPath && (!certPath || !keyPath))) {
    throw new Error("HTTPS_CERT_PATH 与 HTTPS_KEY_PATH 必须同时配置");
  }
  const https =
    certPath && keyPath
      ? {
          key: readFileSync(resolve(projectRoot, keyPath)),
          cert: chainPath
            ? Buffer.concat([
                readFileSync(resolve(projectRoot, certPath)),
                Buffer.from("\n"),
                readFileSync(resolve(projectRoot, chainPath)),
              ])
            : readFileSync(resolve(projectRoot, certPath)),
        }
      : undefined;
  // 代理目标必须与后端实际监听地址（HOST）一致，否则 ECONNREFUSED。
  // HOST=0.0.0.0（监听通配）或未设置时，回退到 127.0.0.1：0.0.0.0 是监听通配符，
  // 作客户端连接目标不可靠（Windows 上行为不一），用 IPv4 loopback 一定可达。
  // 注意：localhost 在本机常解析为 IPv6 ::1，后端仅绑 IPv4 时会 ECONNREFUSED ::1。
  const backendHost = !env.HOST || env.HOST === "0.0.0.0" ? "127.0.0.1" : env.HOST;
  const backend = `${https ? "https" : "http"}://${backendHost}:${backendPort}`;
  return {
    plugins: [react(), VitePWA(PWA_OPTIONS)],
    server: {
      // 监听全网卡（0.0.0.0）以支持局域网/远程访问；可经 HOST 覆盖。
      host: env.HOST ?? "0.0.0.0",
      port: webPort,
      https,
      // Vite 6.2+ 默认拦截非 localhost 的 Host 头（防 DNS rebinding）。
      // 仅当显式绑 loopback（本机独占）时保留默认保护；其余远程访问场景一律放行。
      allowedHosts: env.HOST === "127.0.0.1" || env.HOST === "localhost" ? undefined : true,
      proxy: {
        "/api": { target: backend, changeOrigin: true, secure: false },
        "/ws": { target: backend, changeOrigin: true, secure: false, ws: true },
      },
    },
    build: { outDir: "dist" },
  };
});
