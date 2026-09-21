import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  type Agent,
  McpServerConfigSchema,
  normalizeAgentCredentialRefs,
} from "../domain/agent.js";
import { canManageAgent } from "../domain/agent-policy.js";
import { AgentGitRepositorySchema } from "../domain/git.js";
import {
  type PresetWarning,
  SCENARIO_KEYS,
  validateAgentAgainstPreset,
} from "../domain/scenario-preset.js";
import type { User } from "../domain/user.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { ConnectorStore } from "../ports/connector-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import { AGENT_BUILDER_ID } from "./agent-builder.js";

export interface PlatformToolsDeps {
  user: User;
  agentStore: AgentStore;
  installer: SkillInstaller;
  packStore: SkillPackStore;
  /** credentials 存在性探测（缺失值执行时触发问询，这里仅提示） */
  credentialSets?: CredentialSetStore;
  /** list_connectors 用：当前用户可见连接器清单（仅安全字段，不含 headers 凭证） */
  connectorStore?: ConnectorStore;
  /** finish_builder 用：会话上下文缺省时该工具不可用 */
  conversationStore?: ConversationStore;
  conversationId?: string;
  /** 用户技能仓库同步（write_skill/update_skill 落盘后镜像到用户 git 仓库）；缺省=不同步 */
  skillRepoSync?: { onChanged(userId: string): void };
  /** finish_builder 成功解绑后回调（orchestrator 借此安排原任务自动重派） */
  onBuilderFinish?: () => void;
}

/** MCP 工具返回（结构兼容 SDK CallToolResult，避免依赖其类型导出） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// 注：数组元素类型是擦除泛型（AnyZodRawShape），handler args 的上下文类型是索引 never，
// 故各 handler 用 z.object(shape).parse(args) 做入参校验 + 取回精确类型。

/** 汇总 agent 装备告警：场景 preset 规则 + 凭证值存在性（提示文本，不含任何值本身） */
async function summarizeWarningsFor(deps: PlatformToolsDeps, agent: Agent): Promise<string> {
  const presetWarnings: PresetWarning[] = validateAgentAgainstPreset(agent);
  const missing: string[] = [];
  if (deps.credentialSets && agent.credentials.length > 0) {
    const filled = await deps.credentialSets.getFilledValues(deps.user.id, agent.credentials);
    const have = new Set(filled.map((f) => f.code));
    for (const code of agent.credentials) {
      if (!have.has(code)) missing.push(`凭证 ${code} 的值尚未配置（执行时将触发问询）`);
    }
  }
  const lines = [...presetWarnings.map((w) => `[${w.presetKey}] ${w.message}`), ...missing];
  return lines.length > 0 ? `。⚠️ 装备提示：${lines.join("；")}` : "";
}

const ToolsShape = {
  mode: z.enum(["all", "whitelist"]).describe("all=全开；whitelist=仅白名单（推荐按需最小化）"),
  whitelist: z.array(z.string()).default([]).describe("白名单工具名（如 Read/Glob/Grep/Bash）"),
};
const CreateAgentShape = {
  name: z.string().min(1).describe("智能体名称（同用户下唯一）"),
  description: z.string().optional().describe("一句话职责描述"),
  systemPrompt: z.string().optional().describe("系统提示"),
  skills: z.array(z.string()).optional().describe("技能名列表"),
  defaultSkill: z.string().optional().describe("默认技能（自动追加为 /技能 指令）"),
  tools: z
    .object(ToolsShape)
    .optional()
    .describe("工具范围（缺省 all 全开；须与用户确认后尽量收敛）"),
  scenario: z
    .enum(SCENARIO_KEYS)
    .optional()
    .describe("所属场景：code-dev=代码项目 / kb-qa=知识库问答 / research=调研分析 / ops=运维"),
  credentials: z
    .array(z.string())
    .optional()
    .describe("勾选的凭证模板 code（私有仓库 PAT 等；用户未配值时执行触发问询）"),
  gitRepositories: z
    .array(AgentGitRepositorySchema)
    .optional()
    .describe(
      "绑定的 git 仓库。三步：先选平台方言（github/gitee/jihulab，支持自建 host）→ 再给 HTTPS 地址（不收 SSH，无凭证内嵌；官方域名自动识别方言）→ 私有仓库配 credentialCode（kind=git 且 repoUrl 与本仓库地址一致的凭证模板）。绑定后 donger-git 工具（git_clone/git_pull/git_push 等）自动挂载",
    ),
  /** 允许 shell 直跑 git（默认 false=只准走 donger-git 工具）；须与用户确认后再开 */
  gitAllowShellGit: z
    .boolean()
    .optional()
    .describe("允许 shell git（默认关；开启后绕过工具守卫，git push 仍走审批门）"),
  mcpServers: z.array(McpServerConfigSchema).optional(),
};
const UpdateAgentShape = {
  agentId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  defaultSkill: z.string().optional(),
  scenario: z.enum(SCENARIO_KEYS).optional(),
  credentials: z.array(z.string()).optional(),
  gitRepositories: z.array(AgentGitRepositorySchema).optional(),
  gitAllowShellGit: z.boolean().optional(),
  mcpServers: z.array(McpServerConfigSchema).optional(),
};
const WriteSkillShape = {
  name: z.string().min(1).describe("技能名（建议 *-design/*-execute/*-accept 三段式后缀）"),
  description: z.string().min(1).describe("技能描述（何时使用）"),
  content: z
    .string()
    .min(1)
    .describe("SKILL.md 全文，含 --- frontmatter ---（name/description 与本参数一致）"),
  slug: z.string().optional().describe("pack slug（缺省用技能名；冲突自动加 -2 后缀）"),
};
const SkillRefShape = {
  pack: z.string().min(1).describe("pack slug（list_skills 返回的 pack 字段）"),
  name: z.string().min(1).describe("技能名"),
};
const UpdateSkillShape = {
  ...SkillRefShape,
  content: z.string().min(1).describe("SKILL.md 新全文（frontmatter name 必须与现有技能名一致）"),
};

/** 六个平台工具定义（导出供单测直接调 handler） */
export function platformToolDefinitions(deps: PlatformToolsDeps): SdkMcpToolDefinition[] {
  return [
    {
      name: "list_agents",
      description: "列出当前用户可用（自有+被分享）的智能体：id/名称/描述/skills",
      inputSchema: {},
      handler: async (): Promise<ToolResult> => {
        const mine = await deps.agentStore.listByOwner(deps.user.id);
        const shared = await deps.agentStore.listSharedWith(deps.user.id);
        const rows = [...mine, ...shared].map(({ id, name, description, skills }) => ({
          id,
          name,
          description,
          skills,
        }));
        return ok(JSON.stringify(rows, null, 2));
      },
    },
    {
      name: "create_agent",
      description: "创建智能体（归属当前用户）。写入操作，会弹审批卡确认。",
      inputSchema: CreateAgentShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(CreateAgentShape).parse(args);
        const dup = (await deps.agentStore.listByOwner(deps.user.id)).some(
          (agent) => agent.name === a.name,
        );
        if (dup) return fail(`同名智能体已存在：${a.name}，请换名或改用 update_agent`);
        const skills = a.skills ?? [];
        if (skills.length > 0) {
          const enabled = new Set(
            (await deps.packStore.listEnabledSkillsWithPack(deps.user.id)).map(
              (row) => row.skill.name,
            ),
          );
          const unknown = skills.filter((s) => !enabled.has(s));
          if (unknown.length > 0) {
            return fail(
              `以下技能不存在或未启用：${unknown.join("、")}。请先用 list_skills 核对名称，缺失的先 write_skill 写入。`,
            );
          }
        }
        const agent = await deps.agentStore.create({
          ownerId: deps.user.id,
          name: a.name,
          description: a.description,
          systemPrompt: a.systemPrompt,
          skills,
          defaultSkill: a.defaultSkill,
          tools: a.tools ?? { mode: "all", whitelist: [] },
          scenario: a.scenario,
          credentials: a.credentials ?? [],
          gitRepositories: a.gitRepositories ?? [],
          gitAllowShellGit: a.gitAllowShellGit ?? false,
          mcpServers: a.mcpServers ?? [],
          defaultPermissionMode: "ask_before_change",
        });
        const toolsNote =
          agent.tools.mode === "all"
            ? "工具全开（all）"
            : `工具白名单：${agent.tools.whitelist.join("、") || "空"}`;
        const warnings = await summarizeWarningsFor(deps, agent);
        return ok(
          `已创建智能体 id=${agent.id} name=${agent.name}（${toolsNote}）${warnings}。创建后即自动进入任务分发路由表，无需登记。`,
        );
      },
    },
    {
      name: "update_agent",
      description: "更新智能体（仅限自己创建的或管理员）。写入操作，会弹审批卡确认。",
      inputSchema: UpdateAgentShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(UpdateAgentShape).parse(args);
        const agent = await deps.agentStore.get(a.agentId);
        if (!agent) return fail(`智能体不存在: ${a.agentId}`);
        if (!canManageAgent(agent, deps.user)) return fail("无权修改该智能体（仅创建者或管理员）");
        const patch: Partial<Agent> = {};
        if (a.name !== undefined) patch.name = a.name;
        if (a.description !== undefined) patch.description = a.description;
        if (a.systemPrompt !== undefined) patch.systemPrompt = a.systemPrompt;
        if (a.skills !== undefined) patch.skills = a.skills;
        if (a.defaultSkill !== undefined) patch.defaultSkill = a.defaultSkill;
        if (a.scenario !== undefined) patch.scenario = a.scenario;
        if (a.credentials !== undefined) patch.credentials = a.credentials;
        if (a.gitRepositories !== undefined) patch.gitRepositories = a.gitRepositories;
        if (a.gitAllowShellGit !== undefined) patch.gitAllowShellGit = a.gitAllowShellGit;
        if (a.mcpServers !== undefined) patch.mcpServers = a.mcpServers;
        // 合并视图供告警汇总（credentialCode → credentials 的归一化由 store 收口）
        const merged = normalizeAgentCredentialRefs({ ...agent, ...patch });
        const updated = await deps.agentStore.update(agent.id, patch);
        const warnings = await summarizeWarningsFor(deps, merged);
        return ok(`已更新智能体 ${updated.name}（id=${updated.id}）${warnings}`);
      },
    },
    {
      name: "list_skills",
      description: "列出当前用户已启用的技能：技能名/描述/所属 pack",
      inputSchema: {},
      handler: async (): Promise<ToolResult> => {
        const rows = await deps.packStore.listEnabledSkillsWithPack(deps.user.id);
        return ok(
          JSON.stringify(
            rows.map(({ skill, pack }) => ({
              name: skill.name,
              description: skill.description,
              pack: pack.slug,
            })),
            null,
            2,
          ),
        );
      },
    },
    {
      name: "write_skill",
      description:
        "写入一个技能（SKILL.md 全文，含 frontmatter name/description）。写入操作，会弹审批卡确认。",
      inputSchema: WriteSkillShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(WriteSkillShape).parse(args);
        const pack = await deps.installer.installFromPaste(deps.user.id, {
          content: a.content,
          slug: a.slug,
          name: a.name,
          description: a.description,
        });
        deps.skillRepoSync?.onChanged(deps.user.id);
        return ok(`已写入技能（pack slug=${pack.slug}）`);
      },
    },
    {
      name: "read_skill",
      description: "读取技能 SKILL.md 全文（升级分析用；预装技能只读可读）",
      inputSchema: SkillRefShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(SkillRefShape).parse(args);
        const pack = await deps.packStore.getPackBySlug(deps.user.id, a.pack);
        if (!pack) return fail(`pack 不存在: ${a.pack}`);
        try {
          return ok(await deps.installer.readSkillDoc(deps.user.id, pack.id, a.name));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "update_skill",
      description:
        "更新已有技能的 SKILL.md 全文（仅限自己名下、非预装、非 git 源的技能；frontmatter name 须与现有技能名一致）。写入操作，会弹审批卡确认。",
      inputSchema: UpdateSkillShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(UpdateSkillShape).parse(args);
        const pack = await deps.packStore.getPackBySlug(deps.user.id, a.pack);
        if (!pack) return fail(`pack 不存在: ${a.pack}`);
        try {
          const updated = await deps.installer.updateSkillDoc(
            deps.user.id,
            pack.id,
            a.name,
            a.content,
          );
          deps.skillRepoSync?.onChanged(deps.user.id);
          return ok(`已更新技能 ${a.name}（pack slug=${updated.slug}）`);
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "list_connectors",
      description:
        "列出当前用户可见的连接器（HTTP MCP）：名称/描述/URL/启停。技能引用外部服务时对齐命名；凭证值不出现在结果中。",
      inputSchema: {},
      handler: async (): Promise<ToolResult> => {
        if (!deps.connectorStore) return fail("连接器存储未装配");
        const rows = await deps.connectorStore.listForUser(deps.user.id);
        return ok(
          JSON.stringify(
            rows.map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description,
              url: c.url,
              enabled: c.enabled,
              shareScope: c.shareScope,
            })),
            null,
            2,
          ),
        );
      },
    },
    {
      name: "finish_builder",
      description:
        "补建流程收尾：解除本会话与 Agent Builder 的绑定，此后用户消息恢复正常任务分发。创建完成或用户放弃创建时必须调用。",
      inputSchema: {},
      handler: async (): Promise<ToolResult> => {
        if (!deps.conversationStore || !deps.conversationId) {
          return fail("会话上下文缺失，无法解除绑定");
        }
        const conv = await deps.conversationStore.get(deps.conversationId);
        if (!conv) return fail("会话不存在，无法解除绑定");
        if (conv.agentId !== AGENT_BUILDER_ID) {
          return fail("该会话未绑定 Agent Builder，无需解除");
        }
        await deps.conversationStore.update(deps.conversationId, { agentId: "" });
        deps.onBuilderFinish?.();
        return ok("已解除绑定：系统将自动重派你的原任务到新智能体。请汇总本次补建结果。");
      },
    },
  ];
}

/** 构造 in-process MCP server（注入 RunOptions.platformTools） */
export function createPlatformToolsServer(deps: PlatformToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-platform",
    version: "0.1.0",
    tools: platformToolDefinitions(deps),
  });
}
