import { describe, expect, it } from "vitest";
import { makeCredentialResolver } from "../../src/orchestrator/credential-flow.js";
import type { Channel, CredentialRequest } from "../../src/ports/channel.js";
import type { TaskStore } from "../../src/ports/task-store.js";

function fakeStore() {
  const status: string[] = [];
  return {
    status,
    async updateStatus(_id: string, s: string) {
      status.push(s);
    },
  } as unknown as TaskStore;
}

function fakeChannel(impl?: (req: CredentialRequest) => Promise<Record<string, string>>): Channel {
  const base = {
    id: "test",
    onMessage: () => {},
    send: async () => {},
    requestApproval: async () => ({ approved: true }),
  };
  if (impl) {
    return { ...base, requestCredentials: async (_t, r) => impl(r) } as Channel;
  }
  return base as Channel;
}

const req: CredentialRequest = {
  taskId: "x",
  conversationId: "c1",
  items: [{ key: "K", label: "K", secret: true, packName: "p" }],
};

describe("makeCredentialResolver", () => {
  it("推卡 → 收值 → 返回 + 状态 planning→awaiting_credentials→planning", async () => {
    const store = fakeStore();
    const resolver = makeCredentialResolver(
      store,
      fakeChannel(async (r) => ({ [r.items[0]?.key ?? ""]: "v" })),
      "t1",
    );
    const out = await resolver(req);
    expect(out.K).toBe("v");
    expect((store as unknown as { status: string[] }).status).toEqual([
      "awaiting_credentials",
      "planning",
    ]);
  });

  it("渠道无 requestCredentials → 抛 CredentialRequiredError + 标记 failed", async () => {
    const store = fakeStore();
    const resolver = makeCredentialResolver(store, fakeChannel(), "t1");
    await expect(resolver(req)).rejects.toThrow(/凭证/);
    expect((store as unknown as { status: string[] }).status).toEqual([
      "awaiting_credentials",
      "failed",
    ]);
  });
});
