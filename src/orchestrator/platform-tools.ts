import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Agent } from "../domain/agent.js";
import { canManageAgent } from "../domain/agent-policy.js";
import { appendDispatcherAgentRow } from "../domain/dispatcher-registry.js";
import type { User } from "../domain/user.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import { AGENT_BUILDER_ID } from "./agent-builder.js";

export interface PlatformToolsDeps {
  user: User;
  agentStore: AgentStore;
  installer: SkillInstaller;
  packStore: SkillPackStore;
  kbDir?: string;
  /** finish_builder 用：会话上下文缺省时该工具不可用 */
  conversationStore?: ConversationStore;
  conversationId?: string;
  /** update_kb_registry 用（可选）：登记后用触发补建的原任务干跑一次 dispatcher，验证路由闭环 */
  dispatchDryRun?: () => Promise<{ agentId: string; rationale: string }>;
  /** finish_builder 成功解绑后回调（orchestrator 借此安排原任务自动重派） */
  onBuilderFinish?: () => void;
}

/** MCP 工具返回（结构兼容 SDK CallToolResult，避免依赖其类型导出） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// 注：数组元素类型是擦除泛型（AnyZodRawShape），handler args 的上下文类型是索引 never，
// 故各 handler 用 z.object(shape).parse(args) 做入参校验 + 取回精确类型。
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
};
const UpdateAgentShape = {
  agentId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  defaultSkill: z.string().optional(),
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
const KbRegistryShape = {
  agentId: z.string().min(1).describe("create_agent 返回的智能体 id"),
  name: z.string().min(1).describe("名称"),
  duty: z.string().min(1).describe("职责（一句话）"),
  skills: z.array(z.string()).describe("技能清单"),
  taskTypes: z.string().min(1).describe("适用任务类型"),
  knowledgeBase: z.string().optional().describe("业务知识库（缺省=无）"),
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
          mcpServers: [],
          llm: {},
        });
        const toolsNote =
          agent.tools.mode === "all"
            ? "工具全开（all）"
            : `工具白名单：${agent.tools.whitelist.join("、") || "空"}`;
        return ok(
          `已创建智能体 id=${agent.id} name=${agent.name}（${toolsNote}；登记路由表时 agentId 用此 id）`,
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
        const updated = await deps.agentStore.update(agent.id, patch);
        return ok(`已更新智能体 ${updated.name}（id=${updated.id}）`);
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
        return ok(`已写入技能（pack slug=${pack.slug}）`);
      },
    },
    {
      name: "update_kb_registry",
      description:
        "把智能体登记到任务分发路由表（新建 agent 后必须调用，否则任务分发找不到它）。写入操作，会弹审批卡确认。",
      inputSchema: KbRegistryShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(KbRegistryShape).parse(args);
        const agent = await deps.agentStore.get(a.agentId);
        if (!agent) {
          return fail(`智能体不存在：${a.agentId}（必须用 create_agent 返回的真实 id）`);
        }
        if (!canManageAgent(agent, deps.user)) {
          return fail("只能登记自己创建（或管理）的智能体");
        }
        if (!deps.kbDir) return fail("平台未装配任务管理知识库（kbDir），无法登记");
        const file = join(deps.kbDir, "dispatcher", "agents.md");
        let md: string;
        try {
          md = readFileSync(file, "utf8");
        } catch {
          return fail(`登记表文件不存在: ${file}`);
        }
        let next: string;
        try {
          next = appendDispatcherAgentRow(md, a);
        } catch (e) {
          return fail(`登记失败：${(e as Error).message}`);
        }
        // 原子写：temp + rename，避免并发会话互相覆盖出半行
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, next, "utf8");
        renameSync(tmp, file);

        // 干跑验证（装配了 dispatchDryRun 时）：用原任务跑一次 dispatcher，确认登记真的可路由
        let verifyNote = "";
        if (deps.dispatchDryRun) {
          try {
            const routing = await deps.dispatchDryRun();
            if (routing.agentId === a.agentId) {
              verifyNote = "干跑验证通过：dispatcher 已能把原任务路由到本智能体。";
            } else if (routing.agentId === "none") {
              verifyNote = `⚠️ 干跑验证未通过：dispatcher 仍路由到 none（${routing.rationale}）。请修订职责/适用任务类型描述后重新登记。`;
            } else {
              verifyNote = `⚠️ 干跑验证路由到了其他智能体（${routing.agentId}），请检查职责描述是否与现有智能体重叠。`;
            }
          } catch (e) {
            verifyNote = `（干跑验证失败：${(e as Error).message}；登记本身已生效）`;
          }
        }
        return ok(
          `已登记到路由表：${a.name}（agentId=${a.agentId}）。${verifyNote}请调用 finish_builder 收尾，用户重发原任务即可被分发到该智能体。`,
        );
      },
    },
    {
      name: "finish_builder",
      description:
        "补建流程收尾：解除本会话与 Agent Builder 的绑定，此后用户消息恢复正常任务分发。路由表登记成功或用户放弃创建时必须调用。",
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
