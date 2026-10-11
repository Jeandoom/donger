// Shell 命令三分类决策（INV-6 归一化解码管线 / INV-10 解释器逃逸乘数，spec §4.3）：
//   whitelist-quick  只读豁免族（git 只读子命令/GET 型 curl）→ 免审批，仍过守卫路径判定
//   static-guard     无展开语义，可静态归一 → 能力集守卫判定路径（现状逻辑）
//   needs-approval   含展开/替换/编码特征或解释器 → 强制进审批链（hook 返回 ask 拉回，
//                    即使引擎想内置自动放行；full_access 豁免时放行+审计打标）
// 理论边界（验证报告 §4）：命令语言图灵完备，「检出全部恶意」不可能；本管线的目标是
// 「放行集零恶意形态 + 审批集可用性代价可控」——不可判定的唯一安全去向是审批。
// 对抗形态依据：探针 2026-10-10 B1（base64+eval 实锤穿透）、边界实验 19 例。

/** 命令替换：$() 与反引号——审批不可见阶段的任意 payload 构造（沿 read-only-shell-command 同语义） */
const COMMAND_SUBSTITUTION = /\$\(|`/;
/** 变量展开：$VAR / ${...} / ANSI-C 引用 $'...'——值在执行期才确定，静态归一不可信 */
const VARIABLE_EXPANSION = /\$\{?[_a-zA-Z]|\$'/;
/** glob/brace 展开：执行期展开为多操作数（cat 加星号路径可枚举敏感文件） */
const GLOB_EXPANSION = /[*?]|(^|\s)\{[^}]*\}/;
/** 重定向：写盘/读入都改变命令语义（探针 C2 形态） */
const REDIRECTION = />>|(^|\s)>|(^|\s)</;
/**
 * 解释器与执行乘数（INV-10）：子进程脱离能力集约束，恒审批。
 * 长名用词边界（误报面小）；短名（sh/awk/cmd 等）仅识别「命令位」形态——
 * 否则 deploy.sh 的 .sh、.env 的 env 一类文件名后缀会大面积误报（实测教训）。
 */
const INTERPRETER_LONG =
  /\b(node|nodejs|python3?|perl|ruby|powershell|pwsh|expect|eval|exec|xargs|base64|certutil|mshta|rundll32|regsvr32)\b/i;
const INTERPRETER_SHORT = /(^|&&|\|\||;|\||\$\(|`)\s*(sh|bash|zsh|fish|dash|awk|cmd|php)(\.exe)?\s/i;
const ENV_EXEC = /(^|&&|\|\||;)\s*env\s+\S/;
/** 编码/装载体：出现即不可静态判定 */
const ENCODING = /\b(base64|base32|hex|gzip|openssl|certutil|-enc(odedcommand)?\b)/i;

export type ShellDecision = "whitelist-quick" | "static-guard" | "needs-approval";

/** 单段是否含不可静态判定的展开/替换/编码/解释器特征 */
export function hasUndecidableShellPattern(segment: string): boolean {
  return (
    COMMAND_SUBSTITUTION.test(segment) ||
    VARIABLE_EXPANSION.test(segment) ||
    GLOB_EXPANSION.test(segment) ||
    REDIRECTION.test(segment) ||
    INTERPRETER_LONG.test(segment) ||
    INTERPRETER_SHORT.test(segment) ||
    ENV_EXEC.test(segment) ||
    ENCODING.test(segment)
  );
}

/** 按常见 shell 组合符切段（与 read-only-shell-command.splitShellSegments 同语义） */
function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 三分类决策。段级安全：任一段不可判定则整体审批（组合段无法混过）。
 * 注意：whitelist-quick 免的是「审批」不是「守卫」——路径 token 仍须过 fsDeny/confine
 * （git -C /d/code/donger log -p .env 的路径判定在守卫层，验证报告反例⑤）。
 */
export function classifyShellDecision(
  command: string,
  opts: { isReadOnlyExempt?: (cmd: string) => boolean } = {},
): ShellDecision {
  const segments = splitSegments(command);
  if (segments.length === 0) return "needs-approval";
  let allReadOnly = true;
  for (const seg of segments) {
    if (hasUndecidableShellPattern(seg)) return "needs-approval";
    const exempt = opts.isReadOnlyExempt?.(seg) ?? isGitReadOrGetCurl(seg);
    if (!exempt) allReadOnly = false;
  }
  return allReadOnly ? "whitelist-quick" : "static-guard";
}

/** 段级只读豁免缺省实现：git 只读子命令 / GET 型 curl（与 read-only-shell-command 同口径的轻量版） */
function isGitReadOrGetCurl(segment: string): boolean {
  const GIT_BIN = /\bgit(\.exe)?\s/;
  const GIT_READ =
    /\b(ls-remote|fetch|log|show|diff|status|rev-parse|blame|cat-file|describe|shortlog|reflog|grep|ls-files)\b/;
  const GIT_WRITE =
    /\b(clone|pull|push|merge|commit|checkout|switch|restore|rebase|reset|tag|stash|cherry-pick|revert|worktree|submodule|init|branch|(?<!ls-)remote|apply|am|bisect|clean|gc|mv|rm|notes|replace|bundle|archive)\b/;
  const CURL_BIN = /\bcurl(\.exe)?\b/;
  const CURL_WRITING =
    /(--data(-raw|-urlencode|-binary)?\s|--data$|(^|\s)-d\s|--upload-file|(^|\s)-T\s|--form|(^|\s)-F\s|-X\s*(POST|PUT|DELETE|PATCH)|--request\s*(POST|PUT|DELETE|PATCH))/i;
  if (CURL_BIN.test(segment)) return !CURL_WRITING.test(segment);
  if (GIT_BIN.test(segment)) return GIT_READ.test(segment) && !GIT_WRITE.test(segment);
  return false;
}
