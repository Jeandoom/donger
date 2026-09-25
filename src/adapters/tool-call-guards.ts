import { isAbsolute, resolve, sep } from "node:path";
import { bashKbWriteGuard } from "../domain/bash-kb-guard.js";
import { matchesShellGit } from "../domain/git-shell-guard.js";
import { matchSensitiveRead, sensitiveReadDenyMessage } from "../domain/sensitive-read-guard.js";
import { isStartupSensitivePath } from "../domain/startup-sensitive-paths.js";
import type { RunOptions } from "../ports/agent-runner.js";

/**
 * 引擎无关的工具调用静态守卫（canUseTool / requestPermission 共用）：
 * 白名单强制 → shell git → KB 目录写 → 服务端要害路径读 → 启动敏感文件 → 写入边界。
 * 命中返回拒绝原因；null=未被静态守卫拦截，交给调用方的豁免/审批门逻辑。
 *
 * 提取自 ClaudeAgentRunner.canUseTool 前六段（行为不变）；ZCode 引擎在同一顺序上
 * 复用，保证「守卫表 fail-closed」在所有引擎等价生效（specs/2026-09-25-zcode-engine-integration.md §4.3）。
 */
export interface StaticToolGuardScope {
  toolName: string;
  input: Record<string, unknown>;
  opts: Pick<
    RunOptions,
    | "cwd"
    | "allowedTools"
    | "gitAllowShellGit"
    | "kbWriteGuardRoots"
    | "sensitiveReadPolicy"
    | "workspaceRoot"
    | "allowedWriteRoots"
    | "readOnlyRoots"
  >;
}

export interface GuardDenial {
  message: string;
}

export function runStaticToolGuards({
  toolName,
  input,
  opts,
}: StaticToolGuardScope): GuardDenial | null {
  // 工具白名单强制：allowedTools 之外的工具一律 deny。
  // SDK 的 allowedTools 只约束自动允许集合，未列出的工具会落到权限回调——
  // 不在此处拦截的话，白名单形同虚设（曾导致只读 dispatcher 放行 Bash）。
  if (opts.allowedTools && !opts.allowedTools.includes(toolName)) {
    return {
      message: `工具 ${toolName} 不在该智能体的允许列表内（allowedTools）`,
    };
  }
  // shell git 守卫（收口防线 2）：所有会话默认禁止 Bash 直跑 git（含 CLI/闲聊），
  // 引导用 donger-git 工具；gitAllowShellGit=true（agent 显式逃生门）才放行。
  if (
    toolName === "Bash" &&
    opts.gitAllowShellGit !== true &&
    typeof input.command === "string" &&
    matchesShellGit(input.command)
  ) {
    return {
      message:
        "git 操作请使用 donger-git 工具（git_clone/git_pull/git_push 等）。如确需 shell git，请在智能体配置中开启「允许 shell git」。",
    };
  }
  // KB 目录 Bash 写守卫（spec §9，D6 本期实施）：知识库内容变更唯一通道=kb_* 工具
  // （工具内记账 kb_revisions）；Bash 命中库目录+写模式一律 deny，防止绕过修订账本。
  // 静态检测防常规写法；残余（变量拼接路径等）由 audit_events Bash 全文留痕兜底。
  if (
    toolName === "Bash" &&
    typeof input.command === "string" &&
    opts.kbWriteGuardRoots &&
    opts.kbWriteGuardRoots.length > 0
  ) {
    const guard = bashKbWriteGuard(input.command, opts.kbWriteGuardRoots);
    if (guard.blocked) {
      return {
        message:
          "写入拒绝：知识库目录仅允许经 kb_* 工具变更（自动记入修订账本）。请使用 kb_read/kb_write/kb_delete；如需查阅可用 kb_list/kb_search。",
      };
    }
  }
  // 服务端要害路径读守卫（2026-09-24 审计 H1/D3 收口，全权限模式生效）：
  // 审批门未覆盖的 Bash/Read 直读（cat 生产库、读 .deploy 部署目录、跨用户工作区）
  // 是注入渗出的主通道；字符串守卫是沙箱 denyRead 不可用时的兜底层。
  if (opts.sensitiveReadPolicy && opts.sensitiveReadPolicy.denyRoots.length > 0) {
    const probe =
      toolName === "Bash"
        ? typeof input.command === "string"
          ? input.command
          : null
        : toolName === "Read"
          ? typeof input.file_path === "string"
            ? input.file_path
            : null
          : null;
    if (probe) {
      const hit = matchSensitiveRead(probe, opts.cwd, opts.sensitiveReadPolicy);
      if (hit) {
        return { message: sensitiveReadDenyMessage(hit) };
      }
    }
  }
  // 启动敏感路径硬 deny（规格 §5.3）：.claude/settings.json 承载 hooks/permissions 且
  // CLI 直接执行（不过审批门），workspace 可写即注入持久化逃逸通道；.mcp.json 可注入
  // MCP 服务器。该清单是守卫不是门：任何权限模式（含 full_access）下生效。
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const probe =
      typeof input.file_path === "string"
        ? input.file_path
        : typeof input.notebook_path === "string"
          ? input.notebook_path
          : null;
    if (
      probe &&
      isStartupSensitivePath(resolve(isAbsolute(probe) ? probe : resolve(opts.cwd, probe)))
    ) {
      return {
        message: `写入拒绝：${probe} 是 agent 启动敏感文件（.claude 配置 / .mcp.json），写入会改变后续轮的执行环境`,
      };
    }
  }
  const writeRoots = [
    ...(opts.workspaceRoot ? [resolve(opts.workspaceRoot)] : []),
    ...(opts.allowedWriteRoots ?? []).map((root) => resolve(root)),
  ];
  // 写入边界：direct write tools 必须落在用户工作区或显式读写扩展目录内
  if (
    writeRoots.length > 0 &&
    (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit")
  ) {
    const rawPath =
      typeof input.file_path === "string"
        ? input.file_path
        : typeof input.notebook_path === "string"
          ? input.notebook_path
          : null;
    if (rawPath) {
      const abs = isAbsolute(rawPath) ? rawPath : resolve(opts.cwd, rawPath);
      const deniedByReadOnly = (opts.readOnlyRoots ?? [])
        .map((root) => resolve(root))
        .some((root) => abs.startsWith(root + sep) || abs === root);
      if (deniedByReadOnly) {
        return { message: `写入越界：${rawPath} 位于只读扩展目录内` };
      }
      if (!writeRoots.some((root) => abs.startsWith(root + sep) || abs === root)) {
        return { message: `写入越界：${rawPath} 不在允许的写入目录内` };
      }
    }
  }
  return null;
}
