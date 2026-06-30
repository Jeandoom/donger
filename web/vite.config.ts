import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 后端端口取根 PORT env（默认 3000）；改后端端口时同步改此 target。
const backend = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": backend,
      "/ws": { target: backend.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist" },
});
