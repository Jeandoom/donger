import { defineConfig } from "vitest/config";

// E2E 专用配置（vitest 4 起默认配置的 exclude 连显式路径过滤都生效，test:e2e 会跑零个用例——
// 必须用独立 include 面）。真实环境用例：LLM token、运行中的服务、cli 依赖；
// live 前缀文件再由 E2E_LIVE=1 二次门控，未配置时优雅跳过。
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
