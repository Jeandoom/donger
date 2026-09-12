import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import type { Task } from "../../src/domain/types.js";
import {
  RESTART_INTERRUPTED_REASON,
  sweepInterruptedTasks,
} from "../../src/orchestrator/restart-sweep.js";
import type { StoredMessage } from "../../src/ports/message-store.js";

function taskOf(
  id: string,
  status: Task["status"],
  threadId = "conv-1",
  extra: Partial<Task> = {},
): Task {
  return {
    id,
    channelId: "web",
    threadId,
    requesterId: "u1",
    prompt: "做点事",
    status,
    skillChain: [],
    createdAt: "t",
    updatedAt: "t",
    ...extra,
  };
}

class FakeMessageStore {
  readonly added: Array<{ conversationId: string; role: string; text: string }> = [];
  async add(conversationId: string, role: "user" | "bot", text: string): Promise<StoredMessage> {
    this.added.push({ conversationId, role, text });
    return { id: `m-${this.added.length}`, conversationId, role, text, createdAt: "t" };
  }
  async listByConversation(): Promise<StoredMessage[]> {
    return [];
  }
}

describe("sweepInterruptedTasks（specs/2026-09-12-durable-gate-design.md §2.3）", () => {
  it("running 标失败并补收尾消息；awaiting_credentials 不再被清除", async () => {
    const store = new InMemoryTaskStore();
    await store.create(taskOf("t-running", "running"));
    await store.create(taskOf("t-cred", "awaiting_credentials", "conv-2"));
    const messages = new FakeMessageStore();
    const audit = new InMemoryAuditStore();

    const result = await sweepInterruptedTasks({
      taskStore: store,
      messageStore: messages,
      auditStore: audit,
    });

    expect(result).toMatchObject({ running: 1, resumed: 0, rearmed: 0 });
    expect((await store.get("t-running"))?.status).toBe("failed");
    expect((await store.get("t-cred"))?.status).toBe("awaiting_credentials");
    expect(messages.added.map((m) => m.conversationId)).toEqual(["conv-1"]);
    expect(messages.added[0]?.text).toContain(RESTART_INTERRUPTED_REASON);
  });

  it("awaiting_approval 有持久化决议 → 触发续跑且不补提示", async () => {
    const store = new InMemoryTaskStore();
    await store.create(
      taskOf("t-gate", "awaiting_approval", "conv-2", {
        pendingGate: {
          gateId: "design",
          title: "审批门：方案设计确认",
          requestedAt: "t",
          decision: { approved: true, respondedAt: "t" },
        },
      }),
    );
    const messages = new FakeMessageStore();
    const calls: Array<[string, string]> = [];

    const result = await sweepInterruptedTasks({
      taskStore: store,
      messageStore: messages,
      resumeGatedTask: async (taskId, channelId) => {
        calls.push([taskId, channelId]);
        return "resumed";
      },
    });

    expect(result).toMatchObject({ resumed: 1, rearmed: 0 });
    expect(calls).toEqual([["t-gate", "web"]]);
    expect(messages.added).toHaveLength(0);
  });

  it("awaiting_approval 无决议 → 保留挂起并补提示；续跑回调异常同样落保留", async () => {
    const store = new InMemoryTaskStore();
    await store.create(
      taskOf("t-gate", "awaiting_approval", "conv-2", {
        pendingGate: { gateId: "design", title: "审批门：方案设计确认", requestedAt: "t" },
      }),
    );
    await store.create(
      taskOf("t-gate2", "awaiting_approval", "conv-3", {
        channelId: "dingtalk",
        pendingGate: {
          gateId: "acceptance",
          title: "审批门：验收确认",
          requestedAt: "t",
          decision: { approved: false, respondedAt: "t" },
        },
      }),
    );
    const messages = new FakeMessageStore();

    const result = await sweepInterruptedTasks({
      taskStore: store,
      messageStore: messages,
      resumeGatedTask: async () => {
        throw new Error("boom");
      },
    });

    expect(result).toMatchObject({ resumed: 0, rearmed: 2 });
    expect((await store.get("t-gate"))?.status).toBe("awaiting_approval");
    expect((await store.get("t-gate2"))?.status).toBe("awaiting_approval");
    expect(messages.added[0]?.text).toContain("审批仍然有效");
    expect(messages.added[0]?.text).toContain("方案设计确认");
  });
});
