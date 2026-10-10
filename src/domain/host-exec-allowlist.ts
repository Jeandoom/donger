// host_exec 只读命令白名单判定（纯函数）：host-ops 审批门 agent 级放行用。
// 背景（2026-10-10 拍板）：host-ops 是 force 门，对 host_exec 无差别拦截——
// 只读检查为主的运维 workflow（systemctl is-active / curl 健康检查）每轮必卡人，
// 无人值守场景更是永久挂起。白名单存 agent 配置（hostExecAllowlist，前缀条目），
// 命中且无逃逸结构才自动放行；其余命令仍走审批门。
// 防逃逸口径与 read-only-shell-command 同源并更紧：
//   - 组合段（; && || | & 换行）逐段判定，任何一段未命中 → 整体不放行；
//   - 命令替换（$()、反引号）、进程替换/here-doc（<(、<<）、后台单 & 按段切分；
//   - 输出重定向一律拒绝，唯一例外 >/dev/null 与 2>/dev/null（丢弃输出不落盘）。
// 判定偏保守：误放行=绕过 force 门，误拦截=回审批门（人工兜底），两头不对称。

/** 命令替换：$() 与反引号——审批不可见阶段构造任意 payload 的主通道 */
const COMMAND_SUBSTITUTION = /\$\(|`/;
/** 进程替换 <( 与 here-doc/here-string <<（<<< 含于 <<）：可夹带任意内容 */
const PROCESS_SUBSTITUTION = /<\(|<</;
/** 丢弃输出的重定向（唯一豁免）：>/dev/null、2>/dev/null（容忍空格） */
const NULL_REDIRECT = /\d?>\s*\/dev\/null\b/g;
/** 其余输出重定向：> 与 >>（剥掉 /dev/null 豁免后判定）——把"只读"变成写盘 */
const OUTPUT_REDIRECT = />/;

/** 按 shell 组合符切分；单 & 一并切分（后台执行不构成白名单旁路）。
 *  注意 && 与 || 必须在单字符分支之前（正则交替按序匹配）。 */
function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n|&/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * host_exec 命令是否命中 agent 白名单（全部组合段都以前缀命中某条目才算）。
 * 空白名单 / 空命令 / 含逃逸结构 → false（回审批门）。
 */
export function matchesHostExecAllowlist(command: string, patterns: string[]): boolean {
  const prefixes = patterns.map((p) => p.trim()).filter((p) => p.length > 0);
  if (prefixes.length === 0 || command.trim().length === 0) return false;
  const cleaned = command.replace(NULL_REDIRECT, " ");
  if (COMMAND_SUBSTITUTION.test(cleaned)) return false;
  if (PROCESS_SUBSTITUTION.test(cleaned)) return false;
  if (OUTPUT_REDIRECT.test(cleaned)) return false;
  const segments = splitShellSegments(cleaned);
  if (segments.length === 0) return false;
  return segments.every((seg) => prefixes.some((pre) => seg.startsWith(pre)));
}
