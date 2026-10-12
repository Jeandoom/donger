import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_HOST_EXEC_MIGRATION_FLAG,
  migrateLegacyAgentHostExecAllowlists,
} from "../../src/adapters/host-exec-policy-migration.js";
import { SqliteHostExecPolicyStore } from "../../src/adapters/sqlite-host-exec-policy-store.js";
import type { Agent } from "../../src/domain/agent.js";

function fakeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    ownerId: "owner-1",
    name: "ops",
    createdAt: "2026-10-12T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    ...overrides,
  } as Agent;
}

class MemoryFlags {
  private map = new Map<string, string>();
  getFlag(key: string): string | undefined {
    return this.map.get(key);
  }
  setFlag(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("SqliteHostExecPolicyStore", () => {
  let store: SqliteHostExecPolicyStore;
  beforeEach(() => {
    store = new SqliteHostExecPolicyStore(new Database(":memory:"));
    store.migrate();
  });

  it("create/list/update/setEnabled/remove 全链路", async () => {
    const created = await store.create(
      {
        hostCode: "ssh-homedb",
        tool: "host_exec",
        scopeKind: "agent",
        scopeRef: "a1",
        matchKind: "prefix",
        matchValue: "uptime\ncurl -s",
        decision: "allow",
        unattended: "inherit",
      },
      { createdBy: "admin-1" },
    );
    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);

    const all = await store.list();
    expect(all).toHaveLength(1);

    const updated = await store.update(created.id, {
      hostCode: "*",
      tool: "host_exec",
      scopeKind: "global",
      matchKind: "prefix",
      matchValue: "uptime",
      decision: "ask",
      unattended: "allow",
    });
    expect(updated?.decision).toBe("ask");
    expect(updated?.hostCode).toBe("*");

    const disabled = await store.setEnabled(created.id, false);
    expect(disabled?.enabled).toBe(false);
    expect((await store.list()).every((r) => !r.enabled)).toBe(true);

    expect(await store.remove(created.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.remove(created.id)).toBe(false);
  });
});

describe("migrateLegacyAgentHostExecAllowlists", () => {
  let store: SqliteHostExecPolicyStore;
  beforeEach(() => {
    store = new SqliteHostExecPolicyStore(new Database(":memory:"));
    store.migrate();
  });

  it("白名单非空的 agent 各生成一条等价策略；等价性逐点对齐旧行为", async () => {
    const agents = {
      listAll: async () => [
        fakeAgent({ id: "a1", hostExecAllowlist: ["uptime", "curl -s"] }),
        fakeAgent({ id: "a2" }),
        fakeAgent({ id: "a3", hostExecAllowlist: ["  ", ""] }),
      ],
    };
    const out = await migrateLegacyAgentHostExecAllowlists({ agents, policies: store });
    expect(out.migrated).toBe(1);
    const [rule] = await store.list();
    expect(rule.scopeKind).toBe("agent");
    expect(rule.scopeRef).toBe("a1");
    expect(rule.hostCode).toBe("*");
    expect(rule.tool).toBe("host_exec");
    expect(rule.decision).toBe("allow");
    expect(rule.unattended).toBe("inherit");
    expect(rule.matchValue.split("\n")).toEqual(["uptime", "curl -s"]);
  });

  it("标记位幂等：跑过不再重入，admin 删除迁移产物不被重启复活", async () => {
    const flags = new MemoryFlags();
    const agents = {
      listAll: async () => [fakeAgent({ id: "a1", hostExecAllowlist: ["uptime"] })],
    };
    await migrateLegacyAgentHostExecAllowlists({ agents, policies: store, flags });
    for (const r of await store.list()) await store.remove(r.id);

    const again = await migrateLegacyAgentHostExecAllowlists({ agents, policies: store, flags });
    expect(again.migrated).toBe(0);
    expect(await store.list()).toHaveLength(0);
    expect(flags.getFlag(LEGACY_HOST_EXEC_MIGRATION_FLAG)).toBeTruthy();
  });

  it("无标记位时按 agent 维度幂等（不重复生成）", async () => {
    const agents = {
      listAll: async () => [fakeAgent({ id: "a1", hostExecAllowlist: ["uptime"] })],
    };
    await migrateLegacyAgentHostExecAllowlists({ agents, policies: store });
    const again = await migrateLegacyAgentHostExecAllowlists({ agents, policies: store });
    expect(again.migrated).toBe(0);
    expect(await store.list()).toHaveLength(1);
  });
});
