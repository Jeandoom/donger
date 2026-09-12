import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import type { Task } from "../../src/domain/types.js";
import type { StoredMessage } from "../../src/ports/message-store.js";
import {
  RESTART_AWAITING_REASON,
  RESTART_INTERRUPTED_REASON,
  sweepInterruptedTasks,
} from "../../src/orchestrator/restart-sweep.js";

function taskOf(id: string, status: Task["status"], threadId = "conv-1"): Task {
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
  };
}

class FakeMessageStore {
  readonly added: Array<{ conversationId: string; role: string; text: string }> = [];
  async add(conversationId: string, role: "user" | "bot", text: string): Promise<StoredMessage> {
    this.added.push({ conversationId, role, text });
    return {
      id: `m-${this.added.length}`,
      conversationId,
      role,
      text,
      createdAt: "t",
    };
  }
  async listByConversation(): Promise<StoredMessage[]> {
    return [];
  }
}

describe("sweepInterruptedTasks", () => {
  it("三种遗留状态都标记失败并给会话补收尾消息", async () => {
    const store = new InMemoryTaskStore();
    await store.create(taskOf("t-running", "running"));
    await store.create(taskOf("t-gate", "awaiting_approval", "conv-2"));
    await store.create(taskOf("t-cred", "awaiting_credentials", "conv-3"));
    await store.create(taskOf("t-done", "done"));
    const messages = new FakeMessageStore();
    const audit = new InMemoryAuditStore();

    const result = await sweepInterruptedTasks({ taskStore: store, messageStore: messages, auditStore: audit });

    expect(result).toMatchObject({ running: 1, awaiting: 2, notified: 3 });
    expect((await store.get("t-running"))?.status).toBe("failed");
    expect((await store.get("t-gate"))?.status).toBe("failed");
    expect((await store.get("t-done"))?.status).toBe("done");
    expect(messages.added.map((m) => m.conversationId)).toEqual(["conv-1", "conv-2", "conv-3"]);
    expect(messages.added[0]?.text).toContain(RESTART_INTERRUPTED_REASON);
    expect(messages.added[1]?.text).toContain(RESTART_AWAITING_REASON);
    // 中断留痕审计（result:error 三条）
    const auditEvents = [
      ...(await audit.listByConversation("conv-1")),
      ...(await audit.listByConversation("conv-2")),
      ...(await audit.listByConversation("conv-3")),
    ];
    expect(
      auditEvents.filter((e) => e.type === "result" && e.resultSubtype === "error"),
    ).toHaveLength(3);
  });

  it("无遗留任务时不补发消息", async () => {
    const store = new InMemoryTaskStore();
    const messages = new FakeMessageStore();
    const result = await sweepInterruptedTasks({ taskStore: store, messageStore: messages });
    expect(result).toMatchObject({ running: 0, awaiting: 0, notified: 0 });
    expect(messages.added).toHaveLength(0);
  });

  it("未装配 message/audit store 时仅改状态不补发（兼容最小装配）", async () => {
    const store = new InMemoryTaskStore();
    await store.create(taskOf("t1", "running"));
    const result = await sweepInterruptedTasks({ taskStore: store });
    expect(result).toMatchObject({ running: 1, notified: 0 });
  });
});
