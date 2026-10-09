// 敏感路径读守卫（纯函数）：服务端要害路径读取拦截 + 工作区外读取系统级收口。
// 演进：
//   2026-09-24 审计 H1/D3：审批门只覆盖 deploy/authoring/git-write 三类模式，未命中门
//   的 Bash（cat/环境变量/脚本直读）在任意权限模式静默放行——denyRoots 要害清单 +
//   allowReadRoots 豁免（allow 优先），字符串守卫是沙箱 denyRead 不可用时的兜底。
//   2026-10-09 拍板②（c385dc71 越权复盘）：mode="confine" 读边界系统级升级——agent
//   只能读取本人用户目录（allowReadRoots）内的内容，目录外一律拒绝；不走审批、任何
//   权限模式不豁免。denyRoots 保留作纵深，命中消息可区分「要害路径」与「目录外越界」。
// 同轮拍板①：MSYS 盘符记法归一。Git Bash 下 /d/foo ≡ D:\foo，而 Node resolve 会把
//   前者解析成「当前盘符根下名为 d 的目录」（D:\d\foo 幻影路径），守卫比对全部落空——
//   生产 c385dc71 会话 2026-10-09 实证：Windows 记法的 .env 直读被拦、MSYS 记法的
//   平台数据目录/跨用户主目录/跨盘列举全部放行。归一仅 win32 生效（posix 的 /d 是
//   真实目录，不可改写）。~/ 展开为宿主 home（属目录外，confine 下天然被拒）。
// 双层防线：
//   ① canUseTool/requestPermission 字符串级守卫（本模块；沙箱不可用/unsandboxed 的兜底）
//   ② SDK sandbox filesystem.denyRead（OS 级，claude 引擎；allowRead 即本模块 allowReadRoots）
// allowReadRoots（本人工作区、显式扩展目录）优先级高于 denyRoots——deny 根可以是
// allow 根的祖先（如 deny 平台根目录、allow 用户自己的 homeDir）。

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface SensitiveReadPolicy {
  denyRoots: string[];
  allowReadRoots: string[];
  /** confine=系统级读收口：allowReadRoots 之外一律拒绝。缺省 critical=仅要害清单（旧行为） */
  mode?: "critical" | "confine";
}

export interface SensitiveReadHit {
  /** 命中的 deny 根；outside-allowed 越界命中时为空串 */
  root: string;
  /** 触发的路径 token（归一化前） */
  token: string;
  /** token 按 cwd 解析后的绝对路径（供调用方做存在性判断） */
  resolved: string;
  kind: "critical" | "outside-allowed";
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

/** MSYS 盘符记法 → Windows 盘符（/d/foo → D:/foo）。仅 win32；// 开头的 UNC 不动。 */
function msysToWin32(token: string): string {
  if (process.platform !== "win32") return token;
  const m = /^\/(?!\/)([a-zA-Z])(\/|$)/.exec(token);
  if (!m?.[1]) return token;
  return `${m[1].toUpperCase()}:${token.slice(2)}`;
}

/** ~ 与 ~/ 前缀展开为宿主 home（confine 视角：宿主 home 在用户目录之外） */
function expandTilde(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/") || token.startsWith("~\\")) return homedir() + token.slice(1);
  return token;
}

// MSYS 虚拟设备/伪根（映射进 Git 安装目录，非宿主真实路径）：/dev/null 等 shell
// 高频写法不做越界判定，否则 2>/dev/null 一类命令会被批量误拦。/tmp、/usr 等不豁免：
// Git for Windows 会把 /tmp 挂到宿主 TEMP（属宿主用户目录），按越界处理。
const MSYS_VIRTUAL = /^([a-z]:)?\/(dev|proc|sys)(\/|$)/;

/** 命令 token 切分：空白/引号/shell 组合符/重定向都算边界 */
function tokenize(command: string): string[] {
  return command
    .split(/[\s"'();|&<>]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function toAbsToken(token: string, cwd: string | undefined): string {
  const t = expandTilde(msysToWin32(token));
  return isAbsolute(t) ? t : cwd ? resolve(cwd, t) : resolve(t);
}

/**
 * 判定 Bash 命令 / 工具 file_path 是否越界（allow 优先）。
 * critical 模式：仅命中 denyRoots（allow 豁免）时拒绝。
 * confine 模式：allowReadRoots 之外一律拒绝；denyRoots 命中时优先报「要害路径」。
 * 相对路径按 cwd 解析；cwd 本身也允许为空（工具路径恒为绝对）。
 */
export function matchSensitiveRead(
  raw: string,
  cwd: string | undefined,
  policy: SensitiveReadPolicy,
): SensitiveReadHit | undefined {
  const confine = policy.mode === "confine";
  if (policy.denyRoots.length === 0 && !confine) return undefined;
  for (const token of tokenize(raw)) {
    // 只对像路径的 token 做解析（含分隔符、盘符、~、.. 段）；纯命令词（cat/git）跳过
    const looksPath =
      /[\\/]/.test(token) ||
      /^[a-zA-Z]:/.test(token) ||
      token.startsWith("~") ||
      token.includes("..");
    if (!looksPath) continue;
    const abs = toAbsToken(token, cwd);
    if (MSYS_VIRTUAL.test(normalizePath(abs))) continue;
    if (policy.allowReadRoots.some((a) => isInsideRoot(abs, a))) continue;
    for (const root of policy.denyRoots) {
      if (isInsideRoot(abs, root)) {
        return { root, token, resolved: abs, kind: "critical" };
      }
    }
    if (confine) return { root: "", token, resolved: abs, kind: "outside-allowed" };
  }
  return undefined;
}

/**
 * 组装守卫拒绝消息（agent 可读；指引其走允许范围）。
 * 路径不存在时优先提示路径本身有误（2026-09-28：生产中模型自行推算层级拼出
 * 不存在的路径，被误报「位于保护路径内」，误导排障方向）；存在的路径才谈保护。
 */
export function sensitiveReadDenyMessage(hit: SensitiveReadHit, exists = true): string {
  if (!exists) {
    return `路径不存在：${hit.token}（按当前工作目录解析后无此文件或目录）。请核对路径拼写与层级，优先原样使用系统注入的路径，不要自行推算绝对路径。`;
  }
  if (hit.kind === "outside-allowed") {
    return `读取越界：${hit.token} 不在本用户目录内。系统级限制：agent 只能读取本人用户目录（工作区与扩展目录）内的内容，目录外读取一律拒绝，无法经审批豁免。如需访问其他位置资产，请让用户在平台内挂载（扩展目录 / Git 仓库 / 凭证 / 技能包）。`;
  }
  return `读取拒绝：${hit.token} 位于服务端保护路径内（${hit.root}）。该区域含平台运行数据与其他用户数据，agent 无权访问；如需平台运维请由管理员在服务器上直接操作。`;
}
