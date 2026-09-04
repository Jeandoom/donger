import { CommanderError } from "commander";
import pc from "picocolors";
import { buildProgram } from "./commands.js";

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
        // --help / --version：message 即输出内容
        console.log(e.message);
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
