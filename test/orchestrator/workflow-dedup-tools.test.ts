import { describe, expect, it } from "vitest";
import {
  createWorkflowDedupToolsServer,
  workflowDedupToolDefinitions,
} from "../../src/orchestrator/workflow-dedup-tools.js";
import type { WorkflowDedupStore } from "../../src/ports/workflow-dedup-store.js";

type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

/** 内存 store：claim 用 Map 模拟原子性语义（跨 handler 调用共享） */
function fakeStore(state: Map<string, { runId: string; status: "claimed" | "released" }>) {
  const store: WorkflowDedupStore = {
    migrate: async () => {},
    claim: async (workflowId, dedupKey, runId) => {
      const k = `${workflowId}:${dedupKey}`;
      const cur = state.get(k);
      if (cur && cur.status === "claimed") {
        return {
          claimed: false,
          existing: { workflowId, dedupKey, ...cur, note: null, createdAt: "t", updatedAt: "t" },
        };
      }
      state.set(k, { runId, status: "claimed" });
      return { claimed: true };
    },
    get: async (workflowId, dedupKey) => {
      const cur = state.get(`${workflowId}:${dedupKey}`);
      return cur
        ? { workflowId, dedupKey, ...cur, note: null, createdAt: "t", updatedAt: "t" }
        : undefined;
    },
    release: async (workflowId, dedupKey) => {
      const cur = state.get(`${workflowId}:${dedupKey}`);
      if (!cur || cur.status !== "claimed") return false;
      cur.status = "released";
      return true;
    },
    list: async () => [],
  };
  return store;
}

const text = (r: ToolResult) => r.content[0]?.text ?? "";

describe("workflow-dedup 工具", () => {
  it("dedup_claim：首次 ok；同键第二次提示已认领（isError=false，agent 据此跳过）", async () => {
    const state = new Map<string, { runId: string; status: "claimed" | "released" }>();
    const store = fakeStore(state);
    const server = createWorkflowDedupToolsServer({ workflowId: "wf-1", store });
    expect(server.name).toBe("workflow-dedup");
    const defs = workflowDedupToolDefinitions({ workflowId: "wf-1", store });
    const claim = defs.find((d) => d.name === "dedup_claim")!;
    const r1 = (await claim.handler({ key: "task-1" }, undefined as never)) as ToolResult;
    expect(r1.isError).toBeFalsy();
    expect(text(r1)).toContain("认领成功");
    const r2 = (await claim.handler({ key: "task-1" }, undefined as never)) as ToolResult;
    expect(r2.isError).toBeFalsy();
    expect(text(r2)).toContain("已被认领");
  });

  it("dedup_release 后重认领成功；无 claimed 行时释放报错", async () => {
    const state = new Map<string, { runId: string; status: "claimed" | "released" }>();
    const store = fakeStore(state);
    const defs = workflowDedupToolDefinitions({ workflowId: "wf-1", store });
    const claim = defs.find((d) => d.name === "dedup_claim")!;
    const release = defs.find((d) => d.name === "dedup_release")!;
    await claim.handler({ key: "k1" }, undefined as never);
    const rr = (await release.handler({ key: "k1" }, undefined as never)) as ToolResult;
    expect(rr.isError).toBeFalsy();
    // 已 released：再释放报错（无 claimed 行）
    const rNone = (await release.handler({ key: "k1" }, undefined as never)) as ToolResult;
    expect(rNone.isError).toBe(true);
    // 重认领成功
    const rc = (await claim.handler({ key: "k1" }, undefined as never)) as ToolResult;
    expect(text(rc)).toContain("认领成功");
  });

  it("dedup_query 返回登记状态", async () => {
    const state = new Map<string, { runId: string; status: "claimed" | "released" }>();
    const store = fakeStore(state);
    const defs = workflowDedupToolDefinitions({ workflowId: "wf-1", store });
    const claim = defs.find((d) => d.name === "dedup_claim")!;
    const query = defs.find((d) => d.name === "dedup_query")!;
    await claim.handler({ key: "task-9" }, undefined as never);
    const q = (await query.handler({ key: "task-9" }, undefined as never)) as ToolResult;
    expect(text(q)).toContain('"status": "claimed"');
    const qMiss = (await query.handler({ key: "nope" }, undefined as never)) as ToolResult;
    expect(text(qMiss)).toContain("未登记");
  });
});
