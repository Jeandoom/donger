import { apiFetch } from "./auth";

export interface McpServerDTO {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface AgentGitRepositoryDTO {
  id: string;
  name: string;
  provider: "github" | "gitee" | "jihulab";
  url: string;
  ref?: string;
  required: boolean;
  shallow: boolean;
  syncMode: "cloneOnce" | "fastForward";
  /** 引用凭证模板 code（私有仓库认证；保存时自动并入 credentials） */
  credentialCode?: string;
  /** 浅克隆历史窗口（git --shallow-since，仅 shallow 时生效） */
  shallowSince?: string;
}

export interface AgentExtensionDirectoryDTO {
  id: string;
  name: string;
  path: string;
  access: "readOnly" | "readWrite";
}

/** 会话资源范围（% 会话引用）：enabled 关闭时候选为空（与后端 AgentConversationScopeSchema 同构） */
export interface AgentConversationScopeDTO {
  enabled: boolean;
  /** 有权查看的智能体 id 多选；空数组 = 仅本智能体 */
  agentIds: string[];
  /** 最近 N 天（1-99）；缺省不限天 */
  days?: number;
  /** 最近 N 条（1-99）；缺省 10 */
  limit?: number;
}

/** 反馈资源范围（# 反馈引用）：enabled 关闭时候选为空（与后端 AgentFeedbackScopeSchema 同构；反馈不绑智能体，无 agentIds 维度） */
export interface AgentFeedbackScopeDTO {
  enabled: boolean;
  /** 最近 N 天（1-99）；缺省不限天（按 updatedAt，回复会 bump） */
  days?: number;
  /** 最近 N 条（1-99）；缺省 10 */
  limit?: number;
}

export interface AgentDTO {
  id: string;
  ownerId: string;
  editable?: boolean;
  name: string;
  description?: string;
  systemPrompt?: string;
  skills: string[];
  defaultSkill?: string;
  tools: { mode: "all" | "whitelist"; whitelist: string[] };
  mcpServers: McpServerDTO[];
  /** 勾选的连接器 id（连接器模块注册的 HTTP MCP；保存时后端校验重名） */
  connectorIds?: string[];
  credentials?: string[];
  gitRepositories: AgentGitRepositoryDTO[];
  extensionDirectories: AgentExtensionDirectoryDTO[];
  /** 所属场景：code-dev / kb-qa / research / ops；缺省 = 不做场景校验 */
  scenario?: "code-dev" | "kb-qa" | "research" | "ops";
  /** 允许 shell 直跑 git（默认 false=只准走 donger-git 工具） */
  gitAllowShellGit?: boolean;
  /** 会话资源范围（% 会话引用；缺省 = 功能未开启） */
  conversationScope?: AgentConversationScopeDTO;
  /** 绑定的知识库 id（弱引用；可读即可绑定，被分享库只读挂载） */
  knowledgeBaseIds?: string[];
  /** 自动学习与记忆（默认关）：对话收尾后自动沉淀进绑定的可写库 */
  kbAutoLearn?: boolean;
  /** 独立知识库（可写目标，单选）：自动学习沉淀写入该库；null=未指定（回退全部可写绑定库） */
  kbWriteTargetId?: string | null;
  /** 反馈资源范围（# 反馈引用；缺省 = 功能未开启） */
  feedbackScope?: AgentFeedbackScopeDTO;
  /** 会话权限模式默认值（缺省=变更前问询） */
  defaultPermissionMode?: "ask_before_change" | "full_access";
  createdAt: string;
  updatedAt: string;
}

export interface AgentListDTO extends Omit<AgentDTO, "gitRepositories" | "extensionDirectories"> {
  _mine: boolean;
  gitRepositories?: AgentGitRepositoryDTO[];
  extensionDirectories?: AgentExtensionDirectoryDTO[];
}

/** meta/options 的技能分组：仓库/来源 → 技能（编辑器树形勾选用） */
export interface SkillGroupDTO {
  /** "builtin" | "pack:<packId>" */
  key: string;
  label: string;
  kind: "system" | "pack";
  description?: string;
  /** 人眼可辨的来源：Git 仓库 URL / 本地上传 / 粘贴创建 / 内置 */
  sourceLabel?: string;
  skills: { id: string; name: string; description?: string }[];
}

export interface AgentMeta {
  /** 扁平候选（skillGroups 展开去重，兼容保留） */
  skills: { id: string; name: string; description?: string }[];
  skillGroups: SkillGroupDTO[];
  tools: string[];
  llmPresets: { id: string; name: string; model: string; baseUrl: string }[];
}

export type AgentInput = Omit<AgentDTO, "id" | "ownerId" | "createdAt" | "updatedAt">;

export async function fetchAgents(): Promise<AgentListDTO[]> {
  const r = await apiFetch("/api/agents");
  if (!r.ok) throw new Error(`agents ${r.status}`);
  return (await r.json()) as AgentListDTO[];
}

export async function fetchAgent(id: string): Promise<AgentDTO> {
  const r = await apiFetch(`/api/agents/${id}`);
  if (!r.ok) throw new Error(`agent ${r.status}`);
  return (await r.json()) as AgentDTO;
}

export async function fetchAgentMeta(): Promise<AgentMeta> {
  const r = await apiFetch("/api/agents/meta/options");
  if (!r.ok) throw new Error(`meta ${r.status}`);
  return (await r.json()) as AgentMeta;
}

/** 场景代码 → 中文短标签（列表卡片展示用） */
export const SCENARIO_LABELS: Record<string, string> = {
  "code-dev": "代码项目",
  "kb-qa": "知识问答",
  research: "调研分析",
  ops: "运维操作",
};

export function scenarioLabel(scenario?: string): string {
  return (scenario && SCENARIO_LABELS[scenario]) || "通用";
}

export type AgentSaveResult = AgentDTO & { warnings?: string[] };

/** 从错误响应体提取可读信息（后端校验错误为 {error: string}） */
async function readErrorMessage(r: Response, fallback: string): Promise<string> {
  try {
    const body = (await r.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // 非 JSON 响应
  }
  return fallback;
}

export async function createAgent(input: AgentInput): Promise<AgentSaveResult> {
  const r = await apiFetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `create ${r.status}`));
  return (await r.json()) as AgentSaveResult;
}

export async function updateAgent(id: string, patch: Partial<AgentDTO>): Promise<AgentSaveResult> {
  const r = await apiFetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `update ${r.status}`));
  return (await r.json()) as AgentDTO;
}

export async function deleteAgent(id: string): Promise<void> {
  const r = await apiFetch(`/api/agents/${id}`, { method: "DELETE" });
  if (r.ok || r.status === 204) return;
  throw new Error(await readErrorMessage(r, `delete ${r.status}`));
}

/** 复制智能体（自有∪被分享均可）：只复制非凭证配置，warnings 提示需自行补充的项 */
export async function duplicateAgent(id: string): Promise<AgentSaveResult> {
  const r = await apiFetch(`/api/agents/${id}/duplicate`, { method: "POST" });
  if (!r.ok) throw new Error(await readErrorMessage(r, `duplicate ${r.status}`));
  return (await r.json()) as AgentSaveResult;
}

export async function getOrCreateAgentConversation(agentId: string): Promise<{ id: string }> {
  const r = await apiFetch(`/api/agents/${agentId}/conversation`);
  if (!r.ok) throw new Error(`conv ${r.status}`);
  return (await r.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// 智能体回调链接（specs/2026-09-15-agent-callback-design.md）
// ---------------------------------------------------------------------------

export interface AgentCallbackInfo {
  configured: boolean;
  /** 仅尾 4 位，完整 token 不回传 */
  tokenTail: string | null;
  /** ISO；null = 不过期 */
  expiresAt: string | null;
  createdAt: string | null;
}

export interface AgentCallbackCreated {
  token: string;
  url: string;
  expiresAt: string | null;
}

export async function fetchAgentCallback(id: string): Promise<AgentCallbackInfo> {
  const r = await apiFetch(`/api/agents/${id}/callback`);
  if (!r.ok) throw new Error(`callback ${r.status}`);
  return (await r.json()) as AgentCallbackInfo;
}

/** 生成/重新生成（重新生成即吊销旧链接）；validityDays 缺省 = 不过期 */
export async function generateAgentCallback(
  id: string,
  validityDays?: number,
): Promise<AgentCallbackCreated> {
  const r = await apiFetch(`/api/agents/${id}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validityDays ? { validityDays } : {}),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `callback ${r.status}`));
  return (await r.json()) as AgentCallbackCreated;
}

export async function revokeAgentCallback(id: string): Promise<void> {
  const r = await apiFetch(`/api/agents/${id}/callback`, { method: "DELETE" });
  if (!r.ok) throw new Error(await readErrorMessage(r, `callback ${r.status}`));
}
