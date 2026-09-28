import { defineConfig } from "vitest/config";

// Vitest 配置：Node 环境，测试文件位于 test/ 下
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // e2e 用例依赖真实运行环境（LLM token、运行中的服务、cli 依赖），
    // 不进默认套件；用 `npm run test:e2e` 单独执行
    exclude: ["test/e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});
