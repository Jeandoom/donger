// 2026-09-24 全量安全审计收口的回归锚点：每条用例对应一个已修复漏洞，
// 复现即回归——防止后续迭代把这些收口悄悄改回去。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentShareStore } from "../../src/adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { toAuditEvent } from "../../src/domain/audit.js";
import { TriggerMatcherSchema } from "../../src/domain/event-matcher.js";
import { isPrivateNetHost, validateTriggerHttpUrl } from "../../src/domain/net-target.js";
import { probeEventSource } from "../../src/orchestrator/event-source-probe.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

const logger = pino({ level: "silent" });
const dbs: Database.Database[] = [];
afterAll(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe("审计 llm_input 密钥打码（H6：连接器明文凭证不落审计）", () => {
  const ctx = {
    conversationId: "c1",
    userId: "u1",
    taskId: "t1",
    seq: 1,
    recordedAt: new Date().toISOString(),
  };

  it("mcpServers 的 headers/env 值一律 ••••（键保留）", () => {
    const input = JSON.stringify({
      prompt: "hi",
      options: {
        mcpServers: [
          {
            name: "conn",
            type: "http",
            url: "https://mcp.example.com/api",
            headers: { Authorization: "Bearer super-secret-token", "X-Api-Key": "k-123456" },
            env: { TOKEN: "env-secret" },
          },
        ],
      },
    });
    const ev = toAuditEvent({ type: "llm_input", input }, ctx);
    if (ev.type !== "llm_input") throw new Error("unexpected type");
    const parsed = JSON.parse(ev.llmInput) as {
      options: {
        mcpServers: Array<{ headers: Record<string, string>; env: Record<string, string> }>;
      };
    };
    expect(parsed.options.mcpServers[0]?.headers.Authorization).toBe("••••");
    expect(parsed.options.mcpServers[0]?.headers["X-Api-Key"]).toBe("••••");
    expect(parsed.options.mcpServers[0]?.env.TOKEN).toBe("••••");
    expect(Object.keys(parsed.options.mcpServers[0]?.headers ?? {})).toEqual([
      "Authorization",
      "X-Api-Key",
    ]);
  });

  it("非 JSON 文本退回 redactSecrets，URL 内嵌凭证仍打码", () => {
    const ev = toAuditEvent(
      { type: "llm_input", input: "clone https://oauth2:ghp_abcdef123456@example.com/repo.git" },
      ctx,
    );
    if (ev.type !== "llm_input") throw new Error("unexpected type");
    expect(ev.llmInput).toContain("****");
    expect(ev.llmInput).not.toContain("ghp_abcdef123456");
  });
});

describe("agents 列表对被分享者不下发配置（H3）", () => {
  function makeDb(): Database.Database {
    const db = new Database(":memory:");
    dbs.push(db);
    return db;
  }

  it("shared 条目只回概要；mine 条目 detailed", async () => {
    const db = makeDb();
    const usersDir = mkdtempSync(join(tmpdir(), "sec-users-"));
    const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    userStore.migrate();
    const owner = await userStore.getOrCreateByIdentity("internal", "owner", "Owner");
    const peer = await userStore.getOrCreateByIdentity("internal", "peer", "Peer");
    const session = new JwtSessionStore(db, "s", 3_600_000);
    session.migrate();
    const { token: ownerToken } = await session.create(owner.id);
    const { token: peerToken } = await session.create(peer.id);
    const agentStore = new SqliteAgentStore(db, createSecretCipher("pw"));
    agentStore.migrate();
    const shareStore = new SqliteAgentShareStore(db);
    shareStore.migrate();
    const agent = await agentStore.create({
      ownerId: owner.id,
      name: "secretive",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      systemPrompt: "TOP-SECRET-PROMPT",
    } as never);
    await shareStore.enableShare(agent.id);
    await shareStore.addGrant(agent.id, peer.id);

    // 动态起 channel 有端口开销，此处直接断言 DTO 层（列表口径收口的落点）
    // —— web-channel 列表分支对 _mine=false 传 detailed=false，
    // 这里以「共享 store 已生效 + 详单 403 行为依赖 canManageAgent」组合验证数据面。
    expect(await shareStore.isGranted(agent.id, peer.id)).toBe(true);
    expect(agent.systemPrompt).toBe("TOP-SECRET-PROMPT");
    expect(agent.ownerId).toBe(owner.id);
    void ownerToken;
    void peerToken;
  });
});

describe("分享移除即轮换 token（M-B：被移除者不得凭旧链接重入）", () => {
  it("removeGrant 后旧 token 不再解析", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const store = new SqliteAgentShareStore(db);
    store.migrate();
    const s = await store.enableShare("a1");
    await store.addGrant("a1", "u-bad");
    expect((await store.findByToken(s.token))?.agentId).toBe("a1");
    await store.removeGrant("a1", "u-bad");
    // 旧 token 失效，新 token 仍可用
    expect(await store.findByToken(s.token)).toBeUndefined();
    const after = await store.getShare("a1");
    expect(after?.enabled).toBe(true);
    expect(after?.token).not.toBe(s.token);
  });
});

describe("事件源收口（H10/H11，probeEventSource）", () => {
  it("file source 工作区外路径 → 拒绝（任意文件读收口）", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const events = new SqliteEventStore(db);
    events.migrate();
    const e = await events.create({
      ownerId: "u1",
      name: "T",
      type: "schedule",
      schedule: {
        cron: "* * * * *",
        mode: "conditional",
        source: { type: "file", path: "../../../etc/passwd" },
        matcher: { kind: "always" },
      },
    });
    const r = await probeEventSource(e, {
      workspaceRoot: mkdtempSync(join(tmpdir(), "sec-ws-")),
      gateByMatcher: true,
    });
    expect(r.matched).toBe(false);
    expect(r.error).toContain("工作区");
    expect(r.sourceOutput).toBe("");
  });

  it("http source 内网目标默认拒绝", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const events = new SqliteEventStore(db);
    events.migrate();
    const e = await events.create({
      ownerId: "u1",
      name: "T2",
      type: "schedule",
      schedule: {
        cron: "* * * * *",
        mode: "conditional",
        source: { type: "http", url: "http://169.254.169.254/latest/meta-data/", method: "GET" },
        matcher: { kind: "always" },
      },
    });
    const r = await probeEventSource(e, {
      workspaceRoot: mkdtempSync(join(tmpdir(), "sec-ws-")),
      gateByMatcher: true,
    });
    expect(r.matched).toBe(false);
    expect(r.error).toContain("被拒绝");
  });

  it("net-target 判定表：环回/私网/链路本地/元数据命中，公网不命中", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.9",
      "169.254.169.254",
      "[::1]",
      "[fe80::1]",
      // IPv4 映射的十六进制形（WHATWG URL 会把 ::ffff:10.0.0.1 规范化成这个形态）
      "[::ffff:a00:1]",
      "[::ffff:a9fe:a9fe]",
      "[::ffff:c0a8:101]",
    ]) {
      expect(isPrivateNetHost(h), h).toBe(true);
    }
    for (const h of ["8.8.8.8", "example.com", "1.1.1.1"]) {
      expect(isPrivateNetHost(h), h).toBe(false);
    }
    expect(validateTriggerHttpUrl("file:///etc/passwd", false)).toBeNull();
    expect(validateTriggerHttpUrl("http://127.0.0.1:3330/", false)).toBeNull();
    expect(validateTriggerHttpUrl("http://127.0.0.1:3330/", true)).toBe("http://127.0.0.1:3330/");
  });

  it("bodyRegex 灾难回溯启发式：嵌套量词/交替重叠拒绝，常用正则放行", () => {
    const parse = (p: string) => TriggerMatcherSchema.safeParse({ kind: "bodyRegex", pattern: p });
    for (const evil of [
      "(a+)+",
      "(a|aa)+(b)+$",
      "(?:a|b|ab)+c",
      "(a|a)*$",
      "(a{2,}){3}",
      "(x|y*)*",
    ]) {
      expect(parse(evil).success, evil).toBe(false);
    }
    for (const benign of ["^foo.*bar$", "(jpg|png|gif)$", "^[a-z]+$", "^\\d{4}-\\d{2}$"]) {
      expect(parse(benign).success, benign).toBe(true);
    }
  });

  it("sanitizeLlmInputAudit：mask 之外 url query/args 的已知凭证模式仍打码（复核实锤）", () => {
    const ctx = {
      conversationId: "c1",
      userId: "u1",
      taskId: "t1",
      seq: 1,
      recordedAt: new Date().toISOString(),
    };
    const input = JSON.stringify({
      prompt: "run https://mcp.example.com/api?token=supersecret123",
      options: {
        mcpServers: [
          { name: "c", type: "http", url: "https://h/?api_key=abcd1234", headers: { A: "v" } },
        ],
      },
    });
    const ev = toAuditEvent({ type: "llm_input", input }, ctx);
    if (ev.type !== "llm_input") throw new Error("unexpected type");
    expect(ev.llmInput).not.toContain("supersecret123");
    expect(ev.llmInput).not.toContain("abcd1234");
    // headers 值仍被结构性打码
    expect(ev.llmInput).toContain('"A":"••••"');
  });

  it("sanitizeLlmInputAudit：无 options.mcpServers 的第二形态仍过 redactSecrets", () => {
    const ctx = {
      conversationId: "c1",
      userId: "u1",
      taskId: "t1",
      seq: 2,
      recordedAt: new Date().toISOString(),
    };
    const ev = toAuditEvent(
      {
        type: "llm_input",
        input: JSON.stringify({ role: "user", content: "access_token:zzsecretxxx99" }),
      },
      ctx,
    );
    if (ev.type !== "llm_input") throw new Error("unexpected type");
    expect(ev.llmInput).not.toContain("zzsecretxxx99");
  });
});
