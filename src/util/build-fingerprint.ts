// 前端构建指纹比对：发现 web/dist 与当前源码版本脱节（旧 dist 调新接口导致 404 一类问题）。
// 仅告警不阻断：dev/演示场景允许版本错位运行，但日志给出明确线索。
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";

interface BuildMeta {
  gitHash?: string;
  builtAt?: string;
}

/**
 * 比对 web/dist/.build-meta.json 的 git hash 与当前 HEAD，不一致仅告警。
 * 任一环节无法取证（meta 缺失 / 非 git 环境）都静默跳过。
 */
export function warnIfWebDistStale(distRoot: string, log: Logger): void {
  try {
    const meta = JSON.parse(readFileSync(join(distRoot, ".build-meta.json"), "utf8")) as BuildMeta;
    if (!meta.gitHash) return;
    let head: string;
    try {
      head = execSync("git rev-parse --short HEAD", {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return; // 非 git 环境（生产包部署）无法比对
    }
    if (meta.gitHash !== head) {
      log.warn(
        { distHash: meta.gitHash, headHash: head, builtAt: meta.builtAt },
        "web/dist 与当前源码版本不一致：界面可能调用了已变更的后端接口，请重新执行 npm run build:web",
      );
    }
  } catch {
    // .build-meta.json 不存在（旧构建）——无从比对，跳过
  }
}
