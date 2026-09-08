import { describe, expect, it } from "vitest";
import type { Comment } from "../../src/domain/comment.js";
import type { AuditEvent, Task } from "../../src/domain/types.js";
import { buildOptimizeBrief } from "../../src/orchestrator/optimize-brief.js";

const task: Task = {
  id: "t1",
  channelId: "cli",
  threadId: "c1",
  requesterId: "u1",
  prompt: "开发开销记录工具",
  status: "done",
  skillChain: [],
  createdAt: "2026-09-04T00:00:00Z",
  updatedAt: "2026-09-04T00:10:00Z",
  agentId: "a1",
  phase: "accept",
};

const ev = (over: Partial<AuditEvent>): AuditEvent => ({
  id: "e",
  conversationId: "c1",
  taskId: "t1",
  userId: "u1",
  seq: 0,
  type: "tool_use",
  recordedAt: "2026-09-04T00:01:00Z",
  ...over,
});

const comment: Comment = {
  id: "cm1",
  taskId: "t1",
  userId: "u1",
  text: "错误提示不友好",
  createdAt: "2026-09-04T00:05:00Z",
};

describe("buildOptimizeBrief", () => {
  it("聚合事件统计、失败工具、用户评论与 agent 信息", () => {
    const brief = buildOptimizeBrief({
      task,
      events: [
        ev({ type: "user_message", text: "开发开销记录工具" }),
        ev({ type: "tool_use", toolName: "Write", toolInput: '{"path":"a.js"}' }),
        ev({ type: "tool_result", toolName: "Write", isError: true, toolOutput: "disk full" }),
        ev({
          type: "result",
          resultSubtype: "success",
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          durationMs: 1500,
        }),
      ],
      comments: [comment],
      agent: {
        id: "a1",
        ownerId: "u1",
        name: "expense-cli-dev",
        skills: ["expense-cli-execute"],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        createdAt: "",
        updatedAt: "",
      } as never,
      agentSkillsDir: "/skills/a1",
      agentKbDir: "/kb/a1",
    });

    expect(brief).toContain("任务内容：开发开销记录工具");
    expect(brief).toContain("执行智能体：expense-cli-dev");
    expect(brief).toContain("tool_use×1");
    expect(brief).toContain("[tool_result 失败] Write：disk full");
    expect(brief).toContain("tokens=30");
    expect(brief).toContain("错误提示不友好");
    expect(brief).toContain("skills 文件目录：/skills/a1");
  });

  it("空事件与空评论的兜底文案", () => {
    const brief = buildOptimizeBrief({ task, events: [], comments: [] });
    expect(brief).toContain("（无审计事件）");
    expect(brief).toContain("（无评论）");
  });

  it("长文本截断不破版", () => {
    const brief = buildOptimizeBrief({
      task,
      events: [ev({ type: "user_message", text: "很".repeat(300) })],
      comments: [],
    });
    expect(brief).toContain("…");
    expect(brief.length).toBeLessThan(1200);
  });
});
