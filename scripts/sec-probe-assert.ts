// SEC_ASSERT=1 启动器：双引擎断言模式探针（非零退出码=断言失败，可作 CI 安全门）。
// 用法：npm run probe:security:assert
import { spawnSync } from "node:child_process";

process.env.SEC_ASSERT = "1";
for (const engine of ["claude", "zcode"]) {
  const r = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/sec-probe.ts", engine],
    { stdio: "inherit", env: process.env },
  );
  if (r.status !== 0) {
    console.error(`[probe:security:assert] ${engine} 断言失败（exit=${r.status}）`);
    process.exit(r.status ?? 1);
  }
}
console.log("[probe:security:assert] 双引擎断言全绿");
