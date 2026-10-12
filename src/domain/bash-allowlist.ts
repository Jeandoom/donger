// Bash 命令白名单判定（M2-7，能力集 commands 面，spec §4.2）：
// agent 级 opt-in 收紧——bashAllowlist 非空时，Bash 的每个组合段（&&/||/;/| 切分）
// 必须以某条目为前缀；白名单外 → 强制审批（needsApprovalCheck 落审批卡，任何权限
// 模式含 full_access）。前缀语义与 host-exec-allowlist 同口径：条目 "git status"
// 命中 "git status --short"，条目 "npm" 命中 "npm run build"。

/** 按常见 shell 组合符切段（与 shell-decision.splitSegments 同语义） */
function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 单段是否命中白名单：段以条目为前缀（大小写敏感——命令名/路径语义） */
function segmentMatches(segment: string, allowlist: string[]): boolean {
  return allowlist.some((raw) => {
    const entry = raw.trim();
    if (!entry) return false;
    return segment === entry || segment.startsWith(`${entry} `);
  });
}

/**
 * Bash 命令整体是否在白名单内：全部组合段命中才放行，任一段白名单外即 false。
 * allowlist 空数组视为「白名单为空集」=全部拒绝（显式收紧）；undefined/缺省=功能未启用。
 */
export function matchesBashAllowlist(command: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const segments = splitSegments(command);
  if (segments.length === 0) return false;
  return segments.every((seg) => segmentMatches(seg, allowlist));
}
