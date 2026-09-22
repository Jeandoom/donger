/**
 * KB 目录 Bash 写守卫（spec 2026-09-22-knowledge-base-design §9，D6 本期实施）：
 * Bash 通道不得绕过 kb 工具直写 <workspaceDir>/kb/（否则修订账本被绕过）。
 * 静态文本检测：命令段落命中库目录路径变体 ∧ 含写模式记号 → deny（错误消息引导走 kb_* 工具）。
 * 诚实边界：防"顺手下笔"与常规写法；变量拼接/脚本内间接写防不住（静态门同限），
 * 残余由 audit_events 的 Bash 全文留痕 + 中期回溯审计兜底。
 */

/** 写模式记号（词边界敏感的按需处理）：重定向/tee/复制移动删除/原地编辑类 */
const WRITE_PATTERNS: RegExp[] = [
  /(^|[\s;|&])>{1,2}/, // > 与 >>（含 fd 重定向形态）
  /(^|[\s;|&])tee(\s|$)/,
  /(^|[\s;|&])(cp|mv|rm|unlink|touch|truncate|dd|install|shred)(\s|$)/,
  /(^|[\s;|&])(sed|perl)\s+[^;|&]*-i(\s|$|=)/, // 原地编辑
];

/** 生成一个库根目录的路径形态变体：Windows 反斜杠/正斜杠/MSYS /d/ 形态/UNC 设备路径 */
export function kbRootPathVariants(root: string): string[] {
  const slash = root.replace(/\\/g, "/");
  const variants = new Set<string>([root.toLowerCase(), slash.toLowerCase()]);
  const m = slash.match(/^([A-Za-z]):(\/.*)$/);
  if (m && m[1] && m[2]) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\/+$/, "");
    variants.add(`${drive}:/${rest}`.toLowerCase());
    variants.add(`/${drive}${rest}`.toLowerCase()); // MSYS /d/code/...
    variants.add(`/mnt/${drive}${rest}`.toLowerCase()); // WSL 形态
    variants.add(`\\\\?\\${drive}:${rest.replace(/\//g, "\\")}`.toLowerCase());
  }
  return [...variants];
}

export interface BashKbGuardResult {
  blocked: boolean;
  /** 命中的库根（deny 消息用） */
  matchedRoot?: string;
}

/**
 * 判定 Bash 命令是否试图写入库根目录：
 * 按命令分段（; && || | 换行），段落同时命中「路径变体」与「写模式记号」即 blocked。
 * 只读命令（cat/ls/grep 库目录）不拦。
 */
export function bashKbWriteGuard(command: string, roots: string[]): BashKbGuardResult {
  if (roots.length === 0) return { blocked: false };
  const variants = roots.map((root) => ({ root, variants: kbRootPathVariants(root) }));
  /** 路径边界：变体后必须是路径分隔/引号/串尾，防止 kb-1 误吃 kb-10 前缀 */
  const boundary = (variant: string): RegExp =>
    new RegExp(`${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[/\\\\"'\\s)])`);
  // 分段保序：分隔符替换为换行后逐段
  const segments = command.split(/[;|&\n]+/);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const hit = variants.find((v) => v.variants.some((variant) => boundary(variant).test(lower)));
    if (!hit) continue;
    if (WRITE_PATTERNS.some((re) => re.test(segment))) {
      return { blocked: true, matchedRoot: hit.root };
    }
  }
  return { blocked: false };
}
