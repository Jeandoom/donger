/**
 * MCP 接入分区（授权模块「个人接入」组）：创建/管理个人 MCP 接入令牌，
 * 获取供 zcode / Codex / Claude Code 等外部 agent 使用的 MCP 配置 JSON。
 * 令牌权限与当前用户在 web 端的权限一致。
 */
export function McpSection() {
  return (
    <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
      MCP 接入配置将在 MCP 服务上线后开放（本区块由授权模块布局重构预留）。
    </div>
  );
}
