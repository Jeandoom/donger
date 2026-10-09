// shell git 命令守卫（收口防线 2，纯函数）。2026-10-09 拍板④改版：
//   默认放开——所有 agent 缺省 gitAllowShellGit=true，无需配置；显式 false 才拦，
//   引导改用 donger-git 工具（git_clone/git_pull/git_push…）。
//   前提约束（matchUnsafeShellGit）：鉴权必须 https + 平台系统凭证，非 https 远程/
//   宿主凭证栈/宿主配置写入在任何配置下恒拒。push 另有 deploy force 门兜底。
// 边界如实声明：只能拦「命令文本里的 git 调用」，脚本内间接 spawn git 由
// 防线 1（token 不进 env）兜底，见 specs/2026-09-09-git-platform-tools-design.md §5。

/** git 二进制词法：独立词 git / git.exe（gitx、npx git-parse 等不命中） */
const GIT_BIN = /\bgit(\.exe)?\s/;
/** git 子命令词表：覆盖仓库操作全场景；多为常见英文词，与 GIT_BIN 双条件 AND 降低误伤。
 * config（--global alias '!cmd'/core.fsmonitor 持久化劫持宿主 git）、add/clean/apply/notes
 * （工作区写入/删除/打补丁）不可缺席，否则「全域默认禁 shell git」被 git config 直通击穿。 */
const GIT_SUBCOMMAND =
  /\b(clone|pull|push|fetch|merge|commit|checkout|branch|remote|rebase|reset|tag|ls-remote|stash|cherry-pick|revert|worktree|submodule|init|status|config|add|clean|apply|notes|filter-branch)\b/;

export function matchesShellGit(command: string): boolean {
  return GIT_BIN.test(command) && GIT_SUBCOMMAND.test(command);
}

/**
 * shell git 系统级不可用形态：任何配置（含 gitAllowShellGit=true）下恒拒。
 * 这是「默认放开」的前提——鉴权必须 https + 平台系统凭证：
 *   - credential：宿主凭证栈直读（git credential fill 回显用户名/密码；python
 *     subprocess ["git","credential","fill"] 形态同拦，生产 c385dc71 实证通道存在）
 *   - config --global/--system 与 credential.helper（含仓库级）：宿主 git 配置写入
 *     /helper 注入（helper/insteadOf 持久化劫持）
 *   - 非 https 远程（scp 形 git@host: / ssh:// / git:// / http:// 明文）：平台凭证
 *     解析只在 donger-git 工具台/仓库物化器内按「一凭一仓」绑定发生；会话内刻意
 *     不提供通用 credential.helper（否则任意 ls-remote 即可把凭证递给任意外部主机）。
 */
export function matchUnsafeShellGit(command: string): string | null {
  // credential 子命令调用（宿主凭证栈直读，git credential fill 回显用户名/密码）：
  // ①「git+全局选项链+credential」形态（deploy 门 git-push 模式同思路，覆盖
  //   git -c x=y credential fill 变体）；②python subprocess ["git","credential","fill"]
  //   列表形态（无 git+空白，生产 c385dc71 会话正是这么探的）。commit 消息里带
  //   credential 一词不误伤（消息体不是选项链也不是列表首元素）。
  const GIT_CREDENTIAL_CALL =
    /\bgit(?:\s+(?:-[\w][\w-]*(?:=[^\s"']+)?|-[cC]\s+[^\s"']+|"[^"]*"|'[^']*'))*\s+credential\b|\[\s*\\*["']git\\*["']\s*,\s*\\*["']credential/i;
  if (GIT_CREDENTIAL_CALL.test(command)) {
    return "credential（宿主凭证栈访问）";
  }
  if (
    GIT_BIN.test(command) &&
    /\bconfig\b/.test(command) &&
    /--global|--system|credential\.helper/.test(command)
  ) {
    return "config --global/--system/credential.helper（宿主 git 配置写入或 helper 注入）";
  }
  if (
    GIT_BIN.test(command) &&
    (/\bgit@[^\s'"]+:/i.test(command) || /\b(ssh|git|http):\/\//i.test(command))
  ) {
    return "非 https 远程（SSH / git:// / http:// 明文）";
  }
  return null;
}
