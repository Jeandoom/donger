import { CommanderError } from "commander";
import pc from "picocolors";
import { buildProgram } from "./commands.js";

// DONGER_INSECURE_TLS=1：自签/内网 HTTPS 部署跳过证书校验（仅作用于本进程，须在首次 fetch 前设置）
if (process.env.DONGER_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/** commander 常见错误的中文标签（其余细节保留原文） */
const ZH: Record<string, string> = {
  "commander.missingArgument": "缺少必填参数",
  "commander.missingMandatoryArgumentValue": "缺少必填参数值",
  "commander.unknownOption": "未知选项",
  "commander.invalidArgument": "参数无效",
};

void buildProgram()
  .exitOverride()
  .parseAsync()
  .catch((e: unknown) => {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) {
        // --help / --version：commander 已自行输出，无需重复打印
        return;
      }
      const label = ZH[e.code] ?? "用法错误";
      console.error(pc.red(`${label}：${e.message.replace(/^error:\s*/, "")}`));
      console.error("运行 donger --help 查看用法");
      process.exitCode = 1;
      return;
    }
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
