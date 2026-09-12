// 只读 shell 命令判定（纯函数）：审批门豁免用。
// 背景（2026-09-12 复盘 P2-9）：deploy 门按关键词（含 release）把只读
// git fetch / 平台 API GET 误拦为「部署/发布」，60 秒审批超时致任务失败，
// 且 agent 会用字符串拆分（"rel""ease"）绕过关键词——误拦与规避两头落空。
// 只读命令无远端副作用，直接豁免：既消除误拦，也消除「不得不绕过」的诱导。
// 边界：仅覆盖 git 只读子命令与 GET 型 curl；其余命令一律不算只读（门行为不变）。

/** git 二进制词法：独立词 git / git.exe（gitx、npx git-parse 等不命中），兼容 rtk git 包装 */
const GIT_BIN = /\bgit(\.exe)?\s/;
/** git 只读子命令：无远端副作用（fetch 仅更新本地引用，属安全下载） */
const GIT_READ_SUBCOMMAND =
  /\b(ls-remote|fetch|log|show|diff|status|rev-parse|blame|cat-file|describe|shortlog|reflog|grep|ls-files)\b/;
/** git 有副作用的子命令：出现任一即不算只读（含 branch/remote——带参数时可建分支/改配置）。
 *  remote 用负向断言排除 ls-remote 中的子串 */
const GIT_WRITE_SUBCOMMAND =
  /\b(clone|pull|push|merge|commit|checkout|switch|restore|rebase|reset|tag|stash|cherry-pick|revert|worktree|submodule|init|branch|(?<!ls-)remote|apply|am|bisect|clean|gc|mv|rm|notes|replace|bundle|archive)\b/;
/** curl 的非 GET 形态：携带请求体/上传/显式非 GET 方法 */
const CURL_WRITING =
  /(--data(-raw|-urlencode|-binary)?\s|--data$|(^|\s)-d\s|--upload-file|(^|\s)-T\s|--form|(^|\s)-F\s|-X\s*(POST|PUT|DELETE|PATCH)|--request\s*(POST|PUT|DELETE|PATCH))/i;
const CURL_BIN = /\bcurl(\.exe)?\b/;

/** 命令整体是否只读：所有 git 段只读，且所有 curl 段为 GET 型。含其他命令的段不算只读。 */
export function isReadOnlyShellCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  let sawGitOrCurl = false;
  for (const segment of segments) {
    if (!GIT_BIN.test(segment) && !CURL_BIN.test(segment)) return false;
    sawGitOrCurl = true;
    if (
      GIT_BIN.test(segment) &&
      (!GIT_READ_SUBCOMMAND.test(segment) || GIT_WRITE_SUBCOMMAND.test(segment))
    ) {
      return false;
    }
    if (CURL_BIN.test(segment) && CURL_WRITING.test(segment)) return false;
  }
  return sawGitOrCurl;
}

/** 按常见 shell 组合符切分，让 `git log && git push` 这类组合无法整体混过 */
function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
