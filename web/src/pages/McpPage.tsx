import { McpSection } from "../components/mcp/McpSection";
import { PageHeader } from "../components/ui/page-header";

/**
 * MCP 接入（独立配置模块，沉底导航入口；原授权页「个人接入」分区迁出）：
 * 签发/管理个人 MCP 接入令牌，把平台的智能体 / 会话 / 技能 / 知识库
 * 开放给 zcode、Codex、Claude Code 等外部 agent，所有登录用户可用。
 */
export function McpPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <PageHeader
        title="MCP 接入"
        description="用 MCP 接入令牌把平台的智能体 / 会话 / 技能 / 知识库开放给 zcode、Codex、Claude Code 等外部 agent；令牌权限与你本人登录 web 时完全一致，明文只在创建时展示一次"
      />
      <McpSection />
    </div>
  );
}
