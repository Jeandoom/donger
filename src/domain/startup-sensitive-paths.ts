/**
 * agent 启动敏感路径（设计规格 §5.3）：这些路径的内容会在后续轮被 CLI 直接加载执行
 * （hooks、permissions、MCP 服务器），写入即构成跨轮持久化的执行环境改变。
 * 对 direct write tools 硬 deny，任何权限模式（含 full_access）不豁免——守卫非门。
 *
 * 2026-10-11（M1.5）：zcode hooks 配置入清单——workspace 的 .zcode/config.json 与
 * zcode.json 是 zcode CLI 的 hooks/权限配置入口（内核守卫 hook 注入于此，bundle 实测
 * schema {hooks:{enabled,events}}），agent 篡改即拆守卫（enabled:false / 改 command）。
 * runner 每轮覆写注入 + 此处硬 deny 双保险。
 */
export function isStartupSensitivePath(absPath: string): boolean {
  const segments = absPath.replaceAll("\\", "/").split("/").filter(Boolean);
  // .claude/ 目录内全部文件（settings.json、settings.local.json、commands/ 等）
  if (segments.some((seg) => seg === ".claude")) return true;
  // zcode hooks/权限配置（含 workspace 级 .zcode/ 目录与项目级 zcode.json）
  if (segments.some((seg) => seg === ".zcode")) return true;
  const name = segments[segments.length - 1] ?? "";
  if (name === "zcode.json") return true;
  // SDK 项目级/全局级 MCP 与配置文件
  return name === ".mcp.json" || name === ".claude.json";
}
