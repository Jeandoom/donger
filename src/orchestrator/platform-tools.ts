import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Agent } from "../domain/agent.js";
import { canManageAgent } from "../domain/agent-policy.js";
import { appendDispatcherAgentRow } from "../domain/dispatcher-registry.js";
import type { User } from "../domain/user.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";

export interface PlatformToolsDeps {
  user: User;
  agentStore: AgentStore;
  installer: SkillInstaller;
  packStore: SkillPackStore;
  kbDir?: string;
}

/** MCP 工具返回（结构兼容 SDK CallToolResult，避免依赖其类型导出） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// 注：数组元素类型是擦除泛型（AnyZodRawShape），handler args 的上下文类型是索引 never，
// 故各 handler 用 z.object(shape).parse(args) 做入参校验 + 取回精确类型。
const CreateAgentShape = {
  name: z.string().min(1).describe("智能体名称（同用户下唯一）"),
  description: z.string().optional().describe("一句话职责描述"),
  systemPrompt: z.string().optional().describe("系统提示"),
  skills: z.array(z.string()).optional().describe("技能名列表"),
  defaultSkill: z.string().optional().describe("默认技能（自动追加为 /技能 指令）"),
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
        const agent = await deps.agentStore.create({
          ownerId: deps.user.id,
          name: a.name,
          description: a.description,
          systemPrompt: a.systemPrompt,
          skills: a.skills ?? [],
          defaultSkill: a.defaultSkill,
          tools: { mode: "all", whitelist: [] },
          mcpServers: [],
          llm: {},
        });
        return ok(`已创建智能体 id=${agent.id} name=${agent.name}（登记路由表时 agentId 用此 id）`);
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
        writeFileSync(file, next, "utf8");
        return ok(
          `已登记到路由表：${a.name}（agentId=${a.agentId}）。下一条任务消息即可被分发到该智能体。`,
        );
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
