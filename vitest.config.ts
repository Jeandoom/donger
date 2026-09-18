import { defineConfig } from "vitest/config";

// Vitest 配置：Node 环境，测试文件位于 test/ 下
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
