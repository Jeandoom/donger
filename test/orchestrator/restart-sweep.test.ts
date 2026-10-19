import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteApprovalStore } from "../../src/adapters/sqlite-approval-store.js";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import type { Task } from "../../src/domain/types.js";
import {
  RESTART_AWAITING_REASON,
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
  it("running 孤儿→interrupted（暂停语义，不通知）；awaiting_approval 无行标失败并补收尾消息；awaiting_credentials 不再被清除", async () => {
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

    expect(result).toMatchObject({ interrupted: 1, approvalFailed: 1, approvalRearmed: 0 });
    // running 孤儿：暂停语义（非终态），续跑/通知由 resume-service 接手
    expect((await store.get("t-running"))?.status).toBe("interrupted");
    // 无 pending 审批行（未装配 approvalStore 的升级前存量）：维持旧口径标失败
    expect((await store.get("t-gate"))?.status).toBe("failed");
    expect((await store.get("t-gate"))?.pendingGate).toBeUndefined();
    expect((await store.get("t-cred"))?.status).toBe("awaiting_credentials");
    // sweep 只给无行审批任务发通知；interrupted 的通知归 resume-service
    expect(messages.added.map((m) => m.conversationId)).toEqual(["conv-2"]);
    expect(messages.added[0]?.text).toContain("部署/发布/推送操作审批");
    // 审计补记（seq=-1 约定）
    const audits = await audit.listByConversation("conv-2");
    expect(audits.some((a) => a.text === RESTART_AWAITING_REASON)).toBe(true);
  });

  it("有 pending 审批行的 awaiting_approval 重臂存活（热发布 M3）：不标失败、不发失效通知", async () => {
    const store = new InMemoryTaskStore();
    await store.create(taskOf("t-gate2", "awaiting_approval", "conv-2"));
    const messages = new FakeMessageStore();
    const audit = new InMemoryAuditStore();
    const db = new Database(":memory:");
    const approvalStore = new SqliteApprovalStore(db);
    approvalStore.migrate();
    await approvalStore.create({
      id: "ap-1",
      taskId: "t-gate2",
      conversationId: "conv-2",
      gateId: "deploy",
      title: "审批门：部署/发布/推送操作审批",
      channel: "web",
      status: "pending",
      createdAt: "t",
    });

    const result = await sweepInterruptedTasks({
      taskStore: store,
      messageStore: messages,
      auditStore: audit,
      approvalStore,
    });

    expect(result).toMatchObject({ approvalRearmed: 1, approvalFailed: 0 });
    expect((await store.get("t-gate2"))?.status).toBe("awaiting_approval");
    expect(messages.added).toEqual([]);
  });
});
