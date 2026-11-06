// MCP 服务器级白名单候选目录（编辑页工具白名单的 MCP 分组数据源）。
// entry 与运行时挂载的 server 名一一对应（createSdkMcpServer name / 连接器
// c.name），前缀条目的放行语义见 adapters/tool-call-guards.ts matchesToolWhitelist。
// donger-host 的 available 判定与 orchestrator 装配处同一真源
// （host-tools.ts canViewerUseHostTools），保证「页面所见 = 运行时可挂载」。
import { canViewerUseHostTools } from "../orchestrator/host-tools.js";
import type { ConnectorStore } from "../ports/connector-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { UserStore } from "../ports/user-store.js";

export interface McpWhitelistOption {
  /** 白名单条目（mcp__server 两段前缀，放行该服务器全部工具） */
  entry: string;
  /** 运行时挂载的 server 名 */
  server: string;
  label: string;
  /** 挂载语义提示（何时可用） */
  hint: string;
  /** 当前访问者视角可挂载；false 时编辑页置灰不可勾 */
  available: boolean;
}

export async function buildMcpWhitelistCatalogue(
  deps: {
    credentialSets?: CredentialSetStore;
    connectorStore?: ConnectorStore;
    userStore?: UserStore;
  },
  userId: string,
): Promise<McpWhitelistOption[]> {
  const user = deps.userStore ? await deps.userStore.get(userId) : undefined;
  const role = user?.role === "admin" ? "admin" : "user";
  const hostAvailable = deps.credentialSets
    ? await canViewerUseHostTools(deps.credentialSets, { id: userId, role })
    : false;
  const builtin: McpWhitelistOption[] = [
    {
      entry: "mcp__donger-kb",
      server: "donger-kb",
      label: "知识库",
      hint: "恒挂载",
      available: true,
    },
    {
      entry: "mcp__donger-git",
      server: "donger-git",
      label: "Git 工作区/平台",
      hint: "绑定仓库后挂载",
      available: true,
    },
    {
      entry: "mcp__donger-platform",
      server: "donger-platform",
      label: "平台元工具",
      hint: "仅内置智能体挂载",
      available: true,
    },
    {
      entry: "mcp__donger-host",
      server: "donger-host",
      label: "远程主机",
      hint: hostAvailable
        ? "已可挂载（admin 或名下有已填值主机凭证）"
        : "admin 或名下有已填值主机凭证后挂载",
      available: hostAvailable,
    },
  ];
  const connectors = deps.connectorStore ? await deps.connectorStore.listForUser(userId) : [];
  const connectorOptions: McpWhitelistOption[] = connectors
    .filter((c) => c.type !== "http")
    .map((c) => ({
      entry: `mcp__${c.name}`,
      server: c.name,
      label: c.name,
      hint: c.enabled
        ? "连接器 · 在「MCP 工具」区勾选引用后挂载"
        : "连接器已停用 · 启用并勾选引用后挂载",
      available: c.enabled,
    }));
  const seen = new Set(builtin.map((b) => b.entry));
  return [...builtin, ...connectorOptions.filter((c) => !seen.has(c.entry))];
}
