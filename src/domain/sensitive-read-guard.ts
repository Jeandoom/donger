// 敏感路径读守卫（纯函数）：服务端要害路径的读取拦截清单。
// 背景（2026-09-24 审计 H1，D3 专项收口）：审批门只覆盖 deploy/authoring/git-write
// 三类模式，未命中门的 Bash（cat/环境变量/脚本直读）在任意权限模式静默放行——agent
// 处理的 untrusted 内容（网页抓取/KB/附件/会话引用）一旦注入成功，即可直读生产库、
// 部署目录（.deploy，含 .env 与 donger.db）、平台源码与其他用户工作区。
// 双层防线：
//   ① canUseTool 字符串级守卫（本模块；沙箱不可用/unsandboxed 命令的兜底）
//   ② SDK sandbox filesystem.denyRead（OS 级，同时约束 Read 工具与沙箱内 Bash）
// allowReadRoots（本人工作区、显式扩展目录）优先级高于 denyRoots——deny 根可以
// 是 allow 根的祖先（如 deny 平台根目录、allow 用户自己的 homeDir）。

import { isAbsolute, resolve } from "node:path";

export interface SensitiveReadPolicy {
  denyRoots: string[];
  allowReadRoots: string[];
}

export interface SensitiveReadHit {
  /** 命中的 deny 根 */
  root: string;
  /** 触发的路径 token（归一化前） */
  token: string;
}

/** Windows 不区分大小写；统一小写 + 正斜杠归一后比较 */
function normalizePath(p: string): string {
  const n = resolve(p).toLowerCase().replaceAll("\\", "/");
  return n.endsWith("/") && n.length > 3 ? n.slice(0, -1) : n;
}

function isInsideRoot(child: string, root: string): boolean {
  const c = normalizePath(child);
  const r = normalizePath(root);
  return c === r || c.startsWith(`${r}/`);
}

/** 命令 token 切分：空白/引号/shell 组合符/重定向都算边界 */
function tokenize(command: string): string[] {
  return command
    .split(/[\s"'();|&<>]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * 判定 Bash 命令 / 工具 file_path 是否触达敏感根（allow 优先）。
 * 相对路径按 cwd 解析；cwd 本身也允许为空（工具路径恒为绝对）。
 */
export function matchSensitiveRead(
  raw: string,
  cwd: string | undefined,
  policy: SensitiveReadPolicy,
): SensitiveReadHit | undefined {
  if (policy.denyRoots.length === 0) return undefined;
  for (const token of tokenize(raw)) {
    // 只对像路径的 token 做解析（含分隔符、盘符、~、.. 段）；纯命令词（cat/git）跳过
    const looksPath =
      /[\\/]/.test(token) || /^[a-zA-Z]:/.test(token) || token.startsWith("~") || token.includes("..");
    if (!looksPath) continue;
    const abs = isAbsolute(token) ? token : cwd ? resolve(cwd, token) : resolve(token);
    for (const root of policy.denyRoots) {
      if (!isInsideRoot(abs, root)) continue;
      const allowed = policy.allowReadRoots.some((a) => isInsideRoot(abs, a));
      if (!allowed) return { root, token };
    }
  }
  return undefined;
}

/** 组装守卫拒绝消息（agent 可读；指引其走允许范围） */
export function sensitiveReadDenyMessage(hit: SensitiveReadHit): string {
  return `读取拒绝：${hit.token} 位于服务端保护路径内（${hit.root}）。该区域含平台运行数据与其他用户数据，agent 无权访问；如需平台运维请由管理员在服务器上直接操作。`;
}
