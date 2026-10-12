// 守卫内核（INV-5 参考监视器，spec 2026-10-10-agent-security-kernel-design §4.3）：
// claude PreToolUse hook 与 zcode hook HTTP 端点共用的单实例判定逻辑。
// 输入=工具名+入参；输出=allow / deny（守卫命中）/ needs-approval（解码管线，调用方决定语义：
// claude 转 hook ask 拉审批链；zcode 无 ask 通道，从严 deny——不执行即无泄漏）。
import { existsSync } from "node:fs";
import { EGRESS_BUILTIN_ALLOW, matchEgress } from "../domain/egress-guard.js";
import {
  classifyShellDecision,
} from "../domain/shell-decision.js";
import { matchSensitiveRead, sensitiveReadDenyMessage } from "../domain/sensitive-read-guard.js";
import { runStaticToolGuards, type StaticToolGuardScope } from "./tool-call-guards.js";

export interface GuardKernelVerdict {
  decision: "allow" | "deny" | "needs-approval";
  reason?: string;
}

export function evaluateToolCall(args: {
  toolName: string;
  input: Record<string, unknown>;
  opts: StaticToolGuardScope["opts"];
  /** 解码管线命中时的语义：claude 引擎转 ask（拉审批链），zcode 引擎从严 deny */
  pipelineSemantics: "ask" | "deny";
}): GuardKernelVerdict {
  const { toolName, input, opts, pipelineSemantics } = args;
  // ① 六段静态守卫（白名单/shell git/KB 写/要害路径读/启动敏感文件/写边界）
  const denial = runStaticToolGuards({ toolName, input, opts });
  if (denial) return { decision: "deny", reason: denial.message };
  // ② 工具入参 JSON 全文敏感读扫描：Grep/Glob/MCP 等 tool 的 path 类参数不进
  //    Bash/Read 守卫判定面，序列化后统一过 confine（探针 2026-10-10 B2/B3 实证拦截）
  if (opts.sensitiveReadPolicy) {
    const hit = matchSensitiveRead(JSON.stringify(input), opts.cwd, opts.sensitiveReadPolicy);
    if (hit) {
      return { decision: "deny", reason: sensitiveReadDenyMessage(hit, existsSync(hit.resolved)) };
    }
  }
  // ③④ 强制审批类判定（解码管线 INV-6/10 + 渗出闸 INV-8）
  const approval = needsApprovalCheck(toolName, input, opts);
  if (approval.hit) {
    return { decision: "needs-approval", reason: approval.reason };
  }
  return { decision: "allow" };
}

/**
 * 强制审批类判定（不走守卫拒绝，落审批卡）：解码管线（INV-6/INV-10）+ 渗出闸（INV-8）。
 * claude canUseTool 与 zcode handlePermissionRequest 的合成门 "shell-decision" 用此判定；
 * 任何权限模式（含 full_access）命中即进审批。
 */
export function needsApprovalCheck(
  toolName: string,
  input: Record<string, unknown>,
  opts: StaticToolGuardScope["opts"],
): { hit: boolean; reason?: string } {
  // ③ 解码管线（INV-6/INV-10）：展开/替换/编码/解释器特征
  if (
    toolName === "Bash" &&
    typeof input.command === "string" &&
    classifyShellDecision(input.command) === "needs-approval"
  ) {
    return { hit: true, reason: "内核管线判定：命令含展开/替换/编码/解释器特征" };
  }
  // ④ 渗出闸（INV-8，M2-8）：显式出网（Bash curl/wget、WebFetch URL）域名白名单外
  //    → 审批。白名单内置 localhost 系，LLM API 域与部署扩展域由
  //    RunOptions.egressAllowDomains 并入；恒启用（内置白名单兜底可用性）。
  if (toolName === "Bash" || toolName === "WebFetch") {
    const text =
      toolName === "Bash"
        ? typeof input.command === "string"
          ? input.command
          : ""
        : typeof input.url === "string"
          ? input.url
          : "";
    if (text) {
      const egress = matchEgress(text, [
        ...EGRESS_BUILTIN_ALLOW,
        ...(opts.egressAllowDomains ?? []),
      ]);
      if (egress.blocked) {
        return {
          hit: true,
          reason: `渗出闸：出网目标 ${egress.deniedHosts.join(", ")} 不在放行域名单内，需用户确认`,
        };
      }
    }
  }
  return { hit: false };
}
