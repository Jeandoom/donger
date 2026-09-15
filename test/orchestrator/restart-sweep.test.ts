import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import type { Task } from "../../src/domain/types.js";
import {
  RESTART_AWAITING_REASON,
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

describe("sweepInterruptedTasks", () => {
  it("running/awaiting_approval 标失败并补收尾消息；awaiting_credentials 不再被清除", async () => {
    const store = new InMemoryTaskStore();
    await store.create(taskOf("t-running", "running"));
    await store.create(
      taskOf("t-gate", "awaiting_approval", "conv-2", {
        pendingGate: {
          gateId: "deploy",
          title: "审批门：部署/发布/推送操作审批",
          requestedAt: "t",
        },
      }),
    );
    await store.create(taskOf("t-cred", "awaiting_credentials", "conv-3"));
    const messages = new FakeMessageStore();
    const audit = new InMemoryAuditStore();

    const result = await sweepInterruptedTasks({
      taskStore: store,
      messageStore: messages,
      auditStore: audit,
    });

    expect(result).toMatchObject({ running: 1, awaitingApproval: 1 });
    expect((await store.get("t-running"))?.status).toBe("failed");
    expect((await store.get("t-gate"))?.status).toBe("failed");
    expect((await store.get("t-gate"))?.pendingGate).toBeUndefined();
    expect((await store.get("t-cred"))?.status).toBe("awaiting_credentials");
    expect(messages.added.map((m) => m.conversationId)).toEqual(["conv-1", "conv-2"]);
    expect(messages.added[0]?.text).toContain(RESTART_INTERRUPTED_REASON);
    expect(messages.added[1]?.text).toContain("部署/发布/推送操作审批");
    // 审计补记（seq=-1 约定）
    const audits = await audit.listByConversation("conv-2");
    expect(audits.some((a) => a.text === RESTART_AWAITING_REASON)).toBe(true);
  });
});
