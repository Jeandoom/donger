// workflow-dedup 处理登记工具（spec 2026-10-30-workflow-dedup-design.md §4.2）：
// 「一次业务项只处理一次」的平台硬约束——agent 轮内对业务键（如 TB taskId）原子认领，
// 多条件/多轮/并发命中只有首个认领者继续处理。写边界 = workflowId（构造时闭包绑定），
// 普通聊天轮不挂载、模型传其他 workflowId 一律拒绝（防跨工作流越权）。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WorkflowDedupStore } from "../ports/workflow-dedup-store.js";

export interface WorkflowDedupToolsDeps {
  /** 写边界：仅此工作流的键可操作（构造时闭包绑定） */
  workflowId: string;
  store: WorkflowDedupStore;
}

/** MCP 工具返回（结构兼容 SDK CallToolResult） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const KeyShape = { key: z.string().min(1).max(200).describe("业务键（如 TB taskId）") };

export function workflowDedupToolDefinitions(deps: WorkflowDedupToolsDeps): SdkMcpToolDefinition[] {
  const guard = (key: unknown): string | null =>
    typeof key === "string" && key.trim() ? null : "key 必填";
  return [
    {
      name: "dedup_claim",
      description:
        "原子认领业务键：claimed=true 表示首次认领（本轮应处理）；false 表示已被处理/认领（跳过）。处理失败时用 dedup_release 释放以便重试",
      inputSchema: {
        ...KeyShape,
        note: z.string().max(200).optional().describe("认领备注（如触发条件）"),
      },
      handler: async ({ key, note }) => {
        const denied = guard(key);
        if (denied) return fail(denied);
        const result = await deps.store.claim(deps.workflowId, String(key).trim(), "agent", note);
        if (!result.claimed) {
          return ok(
            `键已被认领（status=${result.existing?.status ?? "?"} at ${result.existing?.createdAt ?? "?"}），跳过处理`,
          );
        }
        return ok("认领成功：本轮应处理该业务项");
      },
    },
    {
      name: "dedup_query",
      description: "查询业务键的登记状态（是否已被认领/释放、认领时间与轮次）",
      inputSchema: KeyShape,
      handler: async ({ key }) => {
        const denied = guard(key);
        if (denied) return fail(denied);
        const entry = await deps.store.get(deps.workflowId, String(key).trim());
        if (!entry) return ok("未登记（从未认领）");
        return ok(JSON.stringify({ status: entry.status, runId: entry.runId, createdAt: entry.createdAt, note: entry.note }, null, 2));
      },
    },
    {
      name: "dedup_release",
      description: "释放业务键（claimed→released）：处理失败时调用，释放后可被重新认领重试",
      inputSchema: {
        ...KeyShape,
        note: z.string().max(200).optional().describe("释放原因"),
      },
      handler: async ({ key, note }) => {
        const denied = guard(key);
        if (denied) return fail(denied);
        const released = await deps.store.release(deps.workflowId, String(key).trim(), note);
        return released ? ok("已释放：该键可被重新认领") : fail("无 claimed 行可释放");
      },
    },
  ];
}

/** 构造 in-process 处理登记工具 MCP server（注入 RunOptions.dedupTools） */
export function createWorkflowDedupToolsServer(
  deps: WorkflowDedupToolsDeps,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "workflow-dedup",
    version: "0.1.0",
    tools: workflowDedupToolDefinitions(deps),
  });
}
