import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { User } from "../../src/domain/user.js";
import type { AuditToolsDeps } from "../../src/orchestrator/audit-tools.js";
import { auditToolDefinitions } from "../../src/orchestrator/audit-tools.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";

const MEMBER: User = {
  id: "u1",
  name: "member",
  role: "user",
  homeDir: "/tmp/u1",
  createdAt: "t",
  updatedAt: "t",
};
const ADMIN: User = { ...MEMBER, id: "admin1", name: "admin", role: "admin" };

/** 会话属主：conv1→u1，conv2→u2 */
const owners = new Map([
  ["conv1", "u1"],
  ["conv2", "u2"],
]);

function makeStore(): InMemoryAuditStore {
  return new InMemoryAuditStore({
    conversationOwner: async (id) => owners.get(id),
  });
}

function mockConvStore(): ConversationStore {
  const rows = new Map<string, Conversation>([
    [
      "conv1",
      {
        id: "conv1",
        userId: "u1",
        sdkSessionId: "",
        title: "修复登录bug",
        channelId: "web",
        agentId: "a1",
        createdAt: "t",
        updatedAt: "t",
        archived: false,
      },
    ],
    [
      "conv2",
      {
        id: "conv2",
        userId: "u2",
        sdkSessionId: "",
        title: "他人的会话",
        channelId: "web",
        agentId: "a1",
        createdAt: "t",
        updatedAt: "t",
        archived: false,
      },
    ],
  ]);
  return {
    async get(id) {
      return rows.get(id);
    },
  } as unknown as ConversationStore;
}

function depsFor(user: User, store: InMemoryAuditStore): AuditToolsDeps {
  return { viewer: user, auditStore: store, conversationStore: mockConvStore() };
}

function tool(deps: AuditToolsDeps, name: string) {
  const t = auditToolDefinitions(deps).find((d) => d.name === name);
  if (!t) throw new Error(`tool 不存在: ${name}`);
  return t;
}

async function seedAll(store: InMemoryAuditStore) {
  const seed = async (
    conversationId: string,
    type: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    await store.record({
      conversationId,
      taskId: `t-${conversationId}`,
      userId: owners.get(conversationId) ?? "u1",
      seq: 0,
      type: type as never,
      text,
      recordedAt: "2026-09-20T10:00:00.000Z",
      ...extra,
    });
  };
  // conv1（u1 自己）：含 llm_input / tool_use（长文本）/ text
  await seed("conv1", "user_message", "帮我修复登录问题");
  await seed("conv1", "llm_input", "SECRET-LLM-INPUT");
  await seed("conv1", "tool_use", "调用工具", {
    toolName: "Bash",
    toolInput: "x".repeat(3000),
    toolOutput: "y".repeat(3000),
  });
  // conv2（u2）：member 不可见
  await seed("conv2", "user_message", "他人搜索关键词needle");
}

describe("donger-audit 工具权限与口径", () => {
  it("member：列表仅本人；他人会话读取报「不存在或无权访问」；搜索不含他人数据", async () => {
    const store = makeStore();
    await seedAll(store);
    const deps = depsFor(MEMBER, store);

    const list = await tool(deps, "audit_list_conversations").handler({ limit: 20, offset: 0 });
    const listBody = JSON.parse(list.content[0]?.text ?? "{}") as {
      conversations: Array<{ conversationId: string }>;
    };
    expect(listBody.conversations.map((c) => c.conversationId)).toEqual(["conv1"]);
    expect(listBody.conversations[0]?.title).toBe("修复登录bug");

    const other = await tool(deps, "audit_get_conversation").handler({
      conversationId: "conv2",
    });
    expect(other.isError).toBe(true);
    expect(other.content[0]?.text).toContain("不存在或无权访问");

    const search = await tool(deps, "audit_search").handler({ keyword: "needle", limit: 30 });
    const searchBody = JSON.parse(search.content[0]?.text ?? "{}") as {
      hits: Array<{ conversationId: string }>;
    };
    expect(searchBody.hits).toEqual([]);

    const own = await tool(deps, "audit_search").handler({ keyword: "登录", limit: 30 });
    expect(own.content[0]?.text).toContain("conv1");
  });

  it("admin：列表与搜索覆盖全部用户", async () => {
    const store = makeStore();
    await seedAll(store);
    const deps = depsFor(ADMIN, store);

    const list = await tool(deps, "audit_list_conversations").handler({ limit: 20, offset: 0 });
    const listBody = JSON.parse(list.content[0]?.text ?? "{}") as {
      conversations: Array<{ conversationId: string }>;
    };
    expect(listBody.conversations.map((c) => c.conversationId).sort()).toEqual(["conv1", "conv2"]);

    const search = await tool(deps, "audit_search").handler({ keyword: "needle", limit: 30 });
    expect(search.content[0]?.text).toContain("conv2");
  });

  it("light 口径：剔除 llm_*、工具出入参默认不返回、超长文本截断；includeToolIo 时截断返回", async () => {
    const store = makeStore();
    await seedAll(store);
    const deps = depsFor(MEMBER, store);

    const light = JSON.parse(
      (await tool(deps, "audit_get_conversation").handler({ conversationId: "conv1" })).content[0]
        ?.text ?? "{}",
    ) as { totalEvents: number; events: Array<Record<string, unknown>> };
    const types = light.events.map((e) => e.type as string);
    expect(types).not.toContain("llm_input");
    expect(light.events.find((e) => e.type === "tool_use")?.toolInput).toBeUndefined();

    const withIo = JSON.parse(
      (
        await tool(deps, "audit_get_conversation").handler({
          conversationId: "conv1",
          includeToolIo: true,
        })
      ).content[0]?.text ?? "{}",
    ) as { events: Array<Record<string, unknown>> };
    const toolUse = withIo.events.find((e) => e.type === "tool_use");
    const input = toolUse?.toolInput as string;
    expect(input.startsWith("x")).toBe(true);
    expect(input.length).toBeLessThan(3000);
    expect(input).toContain("截断");
  });
});
