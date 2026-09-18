/**
 * agent 启动敏感路径（设计规格 §5.3）：这些路径的内容会在后续轮被 CLI 直接加载执行
 * （hooks、permissions、MCP 服务器），写入即构成跨轮持久化的执行环境改变。
 * 对 direct write tools 硬 deny，任何权限模式（含 full_access）不豁免——守卫非门。
 */
export function isStartupSensitivePath(absPath: string): boolean {
  const segments = absPath.replaceAll("\\", "/").split("/").filter(Boolean);
  // .claude/ 目录内全部文件（settings.json、settings.local.json、commands/ 等）
  if (segments.some((seg) => seg === ".claude")) return true;
  const name = segments[segments.length - 1] ?? "";
  // SDK 项目级/全局级 MCP 与配置文件
  return name === ".mcp.json" || name === ".claude.json";
}
