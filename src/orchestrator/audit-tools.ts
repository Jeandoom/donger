import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AuditEvent } from "../domain/types.js";
import type { User } from "../domain/user.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";

export interface AuditToolsDeps {
  /**
   * 查询主体 = 发起对话的用户。构造时闭包绑定，工具 handler 一律以 viewer 身份走
   * visible 语义（member 仅本人 / admin 全量），绝不接受模型传入的 userId、绝不以
   * agent.ownerId 判权（内置 agent ownerId 为空，误用即跨用户越权）。
   */
  viewer: User;
  auditStore: AuditStore;
  conversationStore: ConversationStore;
}

/** MCP 工具返回（结构兼容 SDK CallToolResult，避免依赖其类型导出） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** light 口径截断（对齐审计页回放端点 light=1 的 2000 上限） */
const TRUNCATE = 2000;
function truncate(s: string | undefined, max = TRUNCATE): string | undefined {
  if (s === undefined) return undefined;
  return s.length > max ? `${s.slice(0, max)}…（截断，共 ${s.length} 字符）` : s;
}

const ListShape = {
  limit: z.number().int().min(1).max(50).default(20).describe("返回条数上限（≤50）"),
  offset: z.number().int().min(0).default(0).describe("分页偏移"),
  keyword: z.string().optional().describe("按会话标题过滤（包含匹配）"),
};
const GetShape = {
  conversationId: z.string().min(1).describe("会话 id"),
  includeToolIo: z
    .boolean()
    .default(false)
    .describe("是否附带工具出入参原文（默认只给摘要；llm_* 永不返回）"),
  limit: z.number().int().min(1).max(500).default(200).describe("事件条数上限（≤500）"),
};
const SearchShape = {
  keyword: z.string().min(1).describe("关键词（事件文本包含匹配）"),
  limit: z.number().int().min(1).max(100).default(30).describe("返回条数上限（≤100）"),
};

/** 三个审计读取工具定义（导出供单测直接调 handler） */
export function auditToolDefinitions(deps: AuditToolsDeps): SdkMcpToolDefinition[] {
  const { viewer, auditStore, conversationStore } = deps;
  const isAdmin = viewer.role === "admin";
  return [
    {
      name: "audit_list_conversations",
      description:
        "列出你有权查看的历史会话（member=仅本人，admin=全量）：id/标题/智能体/轮次/token/起止时间",
      inputSchema: ListShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(ListShape).parse(args);
        const summaries = isAdmin
          ? await auditStore.listConversationSummaries()
          : await auditStore.listConversationSummariesVisible(viewer.id);
        // 标题/agent 从会话表补齐；标题过滤在切片前做（分页语义稳定）
        const enriched = await Promise.all(
          summaries.map(async (s) => {
            const conv = await conversationStore.get(s.conversationId);
            return {
              conversationId: s.conversationId,
              title: conv?.title || "(无标题)",
              agentId: conv?.agentId || "",
              turnCount: s.turnCount,
              totalTokens: s.totalTokens,
              firstAt: s.firstAt,
              lastAt: s.lastAt,
            };
          }),
        );
        const kw = a.keyword?.toLowerCase();
        const filtered = kw ? enriched.filter((r) => r.title.toLowerCase().includes(kw)) : enriched;
        const page = filtered.slice(a.offset, a.offset + a.limit);
        return ok(
          JSON.stringify(
            { total: filtered.length, offset: a.offset, conversations: page },
            null,
            2,
          ),
        );
      },
    },
    {
      name: "audit_get_conversation",
      description:
        "读取一个历史会话的审计事件（light 口径：剔除 llm_* 原文、长文本截断）。会话不存在或无权访问时报错，不区分两者",
      inputSchema: GetShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(GetShape).parse(args);
        const events = isAdmin
          ? await auditStore.listByConversation(a.conversationId)
          : await auditStore.listByConversationVisible(viewer.id, a.conversationId);
        if (events.length === 0) return fail("会话不存在或无权访问");
        const clipped = events.slice(0, a.limit);
        const rows = clipped
          .filter((e) => !e.type.startsWith("llm"))
          .map((e) => lightEvent(e, a.includeToolIo));
        return ok(
          JSON.stringify(
            {
              conversationId: a.conversationId,
              totalEvents: events.length,
              returned: rows.length,
              events: rows,
            },
            null,
            2,
          ),
        );
      },
    },
    {
      name: "audit_search",
      description:
        "按关键词检索你有权查看的会话事件文本（member=仅本人会话，admin=全量），按时间倒序返回命中片段",
      inputSchema: SearchShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(SearchShape).parse(args);
        const events = isAdmin
          ? await auditStore.searchByKeyword(a.keyword, a.limit)
          : await auditStore.searchByKeywordVisible(viewer.id, a.keyword, a.limit);
        return ok(
          JSON.stringify(
            {
              keyword: a.keyword,
              hits: events.map((e) => ({
                conversationId: e.conversationId,
                taskId: e.taskId,
                type: e.type,
                toolName: e.toolName,
                recordedAt: e.recordedAt,
                text: truncate(e.text, TRUNCATE),
              })),
            },
            null,
            2,
          ),
        );
      },
    },
  ];
}

/** 事件精简形态：llm_* 已在上游剔除；toolInput/toolOutput 仅 includeToolIo 且仍截断 */
function lightEvent(e: AuditEvent, includeToolIo: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {
    seq: e.seq,
    taskId: e.taskId,
    type: e.type,
    text: truncate(e.text),
    isError: e.isError,
    toolName: e.toolName,
    resultSubtype: e.resultSubtype,
    model: e.model,
    durationMs: e.durationMs,
    usage: e.usage,
    recordedAt: e.recordedAt,
  };
  if (includeToolIo && (e.type === "tool_use" || e.type === "tool_result")) {
    row.toolInput = truncate(e.toolInput);
    row.toolOutput = truncate(e.toolOutput);
  }
  return row;
}

/** 构造 in-process 审计读取 MCP server（注入 RunOptions.auditTools） */
export function createAuditToolsServer(deps: AuditToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-audit",
    version: "0.1.0",
    tools: auditToolDefinitions(deps),
  });
}
