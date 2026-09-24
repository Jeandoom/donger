import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Viewer } from "../../domain/access-policy.js";
import { canManageAgent, canUseAgent } from "../../domain/agent-policy.js";
import type { KbLibrary } from "../../domain/kb.js";
import { canManageKb, canReadKb } from "../../domain/kb-policy.js";
import type { IncomingMessage } from "../../domain/types.js";
import { safeResolveKbPath } from "../../orchestrator/kb-tools.js";
import type { AgentStore } from "../../ports/agent-store.js";
import type { ConversationStore } from "../../ports/conversation-store.js";
import type { KbLibraryStore, KbShareStore } from "../../ports/kb-store.js";
import type { MessageStore } from "../../ports/message-store.js";
import type { SkillPackStore } from "../../ports/skill-pack-store.js";
import { kbRootDir } from "../../util/kb-files.js";
import { type McpToolDef, textResult } from "./rpc.js";

const TEXT_RESULT_CLIP = 12_000;
const MESSAGE_TEXT_CLIP = 8_000;
/** send_message 轮询回复的上限等待 */
const MAX_WAIT_SECONDS = 120;
const POLL_INTERVAL_MS = 2_000;
/** KB 检索上限 */
const KB_SEARCH_MAX_MATCHES = 40;
const KB_SEARCH_MAX_FILE_BYTES = 512 * 1024;
const KB_READ_MAX_BYTES = 64 * 1024;
const KB_WALK_DEPTH = 6;

const TEXT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "markdown",
  "txt",
  "yaml",
  "yml",
  "html",
  "htm",
  "css",
  "scss",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "bat",
  "ps1",
  "sql",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "svg",
  "vue",
  "svelte",
  "log",
  "csv",
  "env",
  "gitignore",
]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return true; // 无扩展名（SKILL.md 之外的 README/Makefile 等）按文本处理
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** MCP 工具依赖：与 web 端 handler 同源的 store 集（权限口径即 web 权限口径） */
export interface McpToolsDeps {
  viewer: Viewer;
  agentStore?: AgentStore;
  conversationStore?: ConversationStore;
  messageStore?: MessageStore;
  kbLibraryStore?: KbLibraryStore;
  kbShareStore?: KbShareStore;
  skillPackStore?: SkillPackStore;
  workspaceDir?: string;
  /** 投递用户消息（= web 通道同一条 handler 链，fire-and-forget） */
  submitMessage: (msg: IncomingMessage) => void;
  /** 会话 git 就绪检查（与 web handleSendMessage 同源；null=未装配视为就绪） */
  gitAccess: (
    userId: string,
    conversationId: string,
  ) => Promise<{ ready: boolean; requirements?: unknown } | undefined>;
}

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required } as Record<string, unknown>;
}

/** 会话可见性（= web owner 守卫口径：属主直通，admin 全量，其余不存在） */
async function visibleConversation(
  deps: McpToolsDeps,
  conversationId: string,
): Promise<{ id: string; userId: string; title: string; agentId: string | null } | undefined> {
  const store = deps.conversationStore;
  if (!store) return undefined;
  const conv =
    deps.viewer.role === "admin"
      ? await store.get(conversationId)
      : await store.getVisible(deps.viewer.id, conversationId);
  return conv ?? undefined;
}

/** 当前用户可读知识库的挂载清单（= orchestrator resolveKbMounts 的读口径子集） */
async function resolveKbMounts(
  deps: McpToolsDeps,
): Promise<
  Array<{ kbId: string; name: string; description?: string; root: string; writable: boolean }>
> {
  const libs = deps.kbLibraryStore;
  if (!libs || !deps.workspaceDir) return [];
  const actor = deps.viewer;
  const isGranted = async (kbId: string): Promise<boolean> =>
    libs && deps.kbShareStore ? await deps.kbShareStore.isGranted(kbId, actor.id) : false;
  const collected = new Map<string, KbLibrary>();
  const mine = await libs.listByOwner(actor.id);
  for (const lib of mine) collected.set(lib.id, lib);
  const shared = await libs.listSharedWith(actor.id);
  for (const lib of shared) collected.set(lib.id, lib);
  for (const lib of await libs.listAll()) {
    if (lib.builtin) collected.set(lib.id, lib);
  }
  const mounts: Array<{
    kbId: string;
    name: string;
    description?: string;
    root: string;
    writable: boolean;
  }> = [];
  for (const lib of collected.values()) {
    if (!canReadKb(lib, actor, await isGranted(lib.id))) continue;
    mounts.push({
      kbId: lib.id,
      name: lib.name,
      ...(lib.description ? { description: lib.description } : {}),
      root: kbRootDir(deps.workspaceDir, lib.id),
      writable: canManageKb(lib, actor),
    });
  }
  return mounts;
}

/** 递归收集库内文本文件（深度与隐藏目录约束同 kb 工具族） */
async function walkTextFiles(root: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 1) out.push(...(await walkTextFiles(full, depth - 1)));
      continue;
    }
    if (!entry.isFile() || !isTextFile(entry.name)) continue;
    try {
      const info = await stat(full);
      if (info.size <= KB_SEARCH_MAX_FILE_BYTES) out.push(full);
    } catch {
      // 竞态删除等：跳过
    }
  }
  return out;
}

/** 知识库行级检索（grep 级子串匹配，大小写不敏感） */
async function searchKbRoot(root: string, query: string): Promise<string[]> {
  const files = await walkTextFiles(root, KB_WALK_DEPTH);
  const needle = query.toLowerCase();
  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= KB_SEARCH_MAX_MATCHES) break;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file).split(sep).join("/");
    const lines = content.split("\n");
    let inFile = 0;
    for (let i = 0; i < lines.length && hits.length < KB_SEARCH_MAX_MATCHES; i++) {
      if (lines[i]?.toLowerCase().includes(needle)) {
        hits.push(`${rel}:${i + 1}: ${(lines[i] ?? "").trim().slice(0, 300)}`);
        inFile++;
        if (inFile >= 5) break; // 单文件最多 5 条，保覆盖面
      }
    }
  }
  return hits;
}

export function buildMcpTools(deps: McpToolsDeps): McpToolDef[] {
  const uid = deps.viewer.id;

  const listAgents: McpToolDef = {
    name: "list_agents",
    description:
      "列出当前用户可用的智能体（本人创建 + 被分享授予的），与 web 端智能体列表口径一致。",
    inputSchema: schema({}),
    handler: async () => {
      if (!deps.agentStore) return textResult("agent store 未装配", true);
      const mine = (await deps.agentStore.listByOwner(uid)).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        mine: true,
      }));
      const shared = (await deps.agentStore.listSharedWith(uid))
        .filter((a) => !mine.some((m) => m.id === a.id))
        .map((a) => ({ id: a.id, name: a.name, description: a.description, mine: false }));
      return textResult(JSON.stringify([...mine, ...shared], null, 2));
    },
  };

  const getAgent: McpToolDef = {
    name: "get_agent",
    description: "查看单个智能体详情；本人/可管理的智能体返回完整配置，被分享的仅返回概要。",
    inputSchema: schema({ agentId: { type: "string", description: "智能体 id" } }, ["agentId"]),
    handler: async (args) => {
      if (!deps.agentStore) return textResult("agent store 未装配", true);
      const agent = await deps.agentStore.get(String(args.agentId ?? ""));
      if (!agent) return textResult("智能体不存在", true);
      const isGranted = (await deps.agentStore.listSharedWith(uid)).some((a) => a.id === agent.id);
      if (!canUseAgent(agent, deps.viewer, isGranted)) return textResult("无权访问该智能体", true);
      if (!canManageAgent(agent, deps.viewer)) {
        return textResult(
          JSON.stringify(
            { id: agent.id, name: agent.name, description: agent.description },
            null,
            2,
          ),
        );
      }
      return textResult(
        JSON.stringify(
          {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            systemPrompt: agent.systemPrompt,
            skills: agent.skills,
            tools: agent.tools,
          },
          null,
          2,
        ),
      );
    },
  };

  const listConversations: McpToolDef = {
    name: "list_conversations",
    description: "列出当前用户自己的会话（最新在前），与 web 端侧栏口径一致。",
    inputSchema: schema({}),
    handler: async () => {
      if (!deps.conversationStore) return textResult("conversation store 未装配", true);
      const list = await deps.conversationStore.listByUser(uid);
      return textResult(
        JSON.stringify(
          list.slice(0, 50).map((c) => ({
            id: c.id,
            title: c.title,
            agentId: c.agentId || null,
            updatedAt: c.updatedAt,
          })),
          null,
          2,
        ),
      );
    },
  };

  const getConversationMessages: McpToolDef = {
    name: "get_conversation_messages",
    description:
      "读取指定会话的消息列表（仅会话属主或管理员）。send_message 发出后可用它轮询回复。",
    inputSchema: schema(
      {
        conversationId: { type: "string" },
        limit: { type: "number", description: "返回最近 N 条，默认 50" },
      },
      ["conversationId"],
    ),
    handler: async (args) => {
      const conversationId = String(args.conversationId ?? "");
      const conv = await visibleConversation(deps, conversationId);
      if (!conv) return textResult("会话不存在或无权访问", true);
      if (!deps.messageStore) return textResult("message store 未装配", true);
      const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 200);
      const all = await deps.messageStore.listByConversation(conversationId);
      const messages = all.slice(-limit).map((m) => ({
        id: m.id,
        role: m.role,
        text: clip(m.text, MESSAGE_TEXT_CLIP),
        createdAt: m.createdAt,
        taskId: m.taskId ?? null,
      }));
      return textResult(JSON.stringify({ conversationId, messages }, null, 2));
    },
  };

  const createConversation: McpToolDef = {
    name: "create_conversation",
    description: "创建会话（可绑定智能体），返回 conversationId，随后可 send_message。",
    inputSchema: schema({
      title: { type: "string", description: "会话标题，缺省「MCP 对话」" },
      agentId: { type: "string", description: "可选：绑定的智能体 id" },
    }),
    handler: async (args) => {
      if (!deps.conversationStore) return textResult("conversation store 未装配", true);
      const title =
        String(args.title ?? "")
          .trim()
          .slice(0, 60) || "MCP 对话";
      const agentId = String(args.agentId ?? "").trim();
      const conv = agentId
        ? await deps.conversationStore.createWithAgent(uid, "web", title, agentId)
        : await deps.conversationStore.create(uid, "web", title);
      return textResult(JSON.stringify({ conversationId: conv.id, title: conv.title }, null, 2));
    },
  };

  const sendMessage: McpToolDef = {
    name: "send_message",
    description:
      "向会话发送用户消息并触发 agent 执行（与会话属主身份一致）。waitSeconds>0 时等待并返回首轮回复；超时未回可用 get_conversation_messages 稍后再取。",
    inputSchema: schema(
      {
        conversationId: { type: "string" },
        text: { type: "string" },
        waitSeconds: {
          type: "number",
          description: "等待回复秒数，默认 30，上限 120；0 = 只发送不等",
        },
      },
      ["conversationId", "text"],
    ),
    handler: async (args) => {
      const conversationId = String(args.conversationId ?? "");
      const text = String(args.text ?? "");
      if (!text.trim()) return textResult("text 不能为空", true);
      const conv = await visibleConversation(deps, conversationId);
      if (!conv) return textResult("会话不存在或无权访问", true);
      const git = await deps.gitAccess(uid, conversationId);
      if (git && !git.ready) {
        return textResult(
          `会话绑定的 Git 仓库未就绪，请先在 web 端完成凭证配置：${JSON.stringify(git.requirements ?? {})}`,
          true,
        );
      }
      if (!deps.messageStore) return textResult("message store 未装配", true);
      const startedAt = new Date().toISOString();
      await deps.messageStore.add(conversationId, "user", text);
      deps.submitMessage({
        channelId: "web",
        threadId: conversationId,
        requesterId: uid,
        text,
        conversationId,
      });
      const waitSeconds = Math.min(
        Math.max(Number(args.waitSeconds ?? 30) || 0, 0),
        MAX_WAIT_SECONDS,
      );
      if (waitSeconds <= 0) {
        return textResult(JSON.stringify({ conversationId, accepted: true }, null, 2));
      }
      const deadline = Date.now() + waitSeconds * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const all = await deps.messageStore.listByConversation(conversationId);
        const reply = all.find((m) => m.role === "bot" && m.createdAt >= startedAt);
        if (reply) {
          return textResult(
            JSON.stringify({ conversationId, reply: clip(reply.text, TEXT_RESULT_CLIP) }, null, 2),
          );
        }
      }
      return textResult(
        JSON.stringify(
          {
            conversationId,
            accepted: true,
            note: `已发送；${waitSeconds}s 内未收到回复，任务仍在执行，可用 get_conversation_messages 稍后读取。`,
          },
          null,
          2,
        ),
      );
    },
  };

  const listSkills: McpToolDef = {
    name: "list_skills",
    description: "列出当前用户已启用的技能包与技能（与 web 技能页口径一致）。",
    inputSchema: schema({}),
    handler: async () => {
      if (!deps.skillPackStore) return textResult("skill store 未装配", true);
      const rows = await deps.skillPackStore.listEnabledSkillsWithPack(uid);
      return textResult(
        JSON.stringify(
          rows.map((r) => ({
            name: r.skill.name,
            description: r.skill.description,
            pack: r.pack.name,
          })),
          null,
          2,
        ),
      );
    },
  };

  const listKnowledgeBases: McpToolDef = {
    name: "list_knowledge_bases",
    description: "列出当前用户可读的知识库（本人 + 被分享 + 内置），与 web 知识库页口径一致。",
    inputSchema: schema({}),
    handler: async () => {
      const mounts = await resolveKbMounts(deps);
      return textResult(
        JSON.stringify(
          mounts.map((m) => ({
            kbId: m.kbId,
            name: m.name,
            description: m.description ?? "",
            writable: m.writable,
          })),
          null,
          2,
        ),
      );
    },
  };

  const searchKnowledgeBase: McpToolDef = {
    name: "search_knowledge_base",
    description: "在知识库中做行级关键词检索（省略 kbId 时在全部可读库中检索）。",
    inputSchema: schema(
      {
        query: { type: "string", description: "关键词（大小写不敏感子串）" },
        kbId: { type: "string", description: "可选：限定知识库 id" },
      },
      ["query"],
    ),
    handler: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) return textResult("query 不能为空", true);
      const mounts = await resolveKbMounts(deps);
      if (mounts.length === 0) return textResult("没有可读的知识库", true);
      const kbId = String(args.kbId ?? "").trim();
      const targets = kbId ? mounts.filter((m) => m.kbId === kbId) : mounts;
      if (kbId && targets.length === 0) return textResult("知识库不存在或无权访问", true);
      const out: string[] = [];
      for (const mount of targets) {
        const hits = await searchKbRoot(mount.root, query);
        if (hits.length === 0) continue;
        out.push(`# ${mount.name} (${mount.kbId})`, ...hits, "");
        if (out.length >= KB_SEARCH_MAX_MATCHES + 8) break;
      }
      if (out.length === 0) return textResult(`无命中：${query}`);
      return textResult(clip(out.join("\n"), TEXT_RESULT_CLIP));
    },
  };

  const readKnowledgeBase: McpToolDef = {
    name: "read_knowledge_base",
    description: "读取知识库内单个文本条目内容（相对路径，来自 search/list 结果）。",
    inputSchema: schema(
      { kbId: { type: "string" }, path: { type: "string", description: "库内相对路径" } },
      ["kbId", "path"],
    ),
    handler: async (args) => {
      const kbId = String(args.kbId ?? "");
      const relPath = String(args.path ?? "");
      const mounts = await resolveKbMounts(deps);
      const mount = mounts.find((m) => m.kbId === kbId);
      if (!mount) return textResult("知识库不存在或无权访问", true);
      const resolved = safeResolveKbPath(mount.root, relPath);
      if (!resolved) return textResult("非法路径", true);
      try {
        const info = await stat(resolved);
        if (!info.isFile()) return textResult("不是文件", true);
        const truncated = info.size > KB_READ_MAX_BYTES;
        const content = (await readFile(resolved, "utf8")).slice(0, KB_READ_MAX_BYTES);
        return textResult(clip(truncated ? `${content}\n…（已截断）` : content, TEXT_RESULT_CLIP));
      } catch {
        return textResult("条目不存在或不可读", true);
      }
    },
  };

  return [
    listAgents,
    getAgent,
    listConversations,
    createConversation,
    sendMessage,
    getConversationMessages,
    listSkills,
    listKnowledgeBases,
    searchKnowledgeBase,
    readKnowledgeBase,
  ];
}
