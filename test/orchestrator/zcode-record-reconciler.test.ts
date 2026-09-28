import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { redactSecrets } from "../../src/domain/audit.js";
import { reconcileZcodeRound } from "../../src/orchestrator/zcode-record-reconciler.js";
import type { MessageStore, StoredMessage } from "../../src/ports/message-store.js";

/** zcode-home db.sqlite 的最小 fixture（reconciler 只依赖 part/message 两表） */
function buildZcodeDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, data TEXT
    );
  `);
  const msg = db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  const part = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  );
  const S = "sess-1";
  const message = (id: string, role: string, tc: number) =>
    msg.run(id, S, tc, JSON.stringify({ role }));
  const textPart = (id: string, mid: string, text: string, tc: number) =>
    part.run(id, mid, S, tc, JSON.stringify({ type: "text", text }));
  const toolPart = (
    id: string,
    mid: string,
    callID: string,
    state: Record<string, unknown>,
    tc: number,
  ) => part.run(id, mid, S, tc, JSON.stringify({ type: "tool", callID, tool: "Bash", state }));
  const stepPart = (
    id: string,
    mid: string,
    kind: "step-start" | "step-finish",
    tc: number,
    extra: Record<string, unknown> = {},
  ) => part.run(id, mid, S, tc, JSON.stringify({ type: kind, ...extra }));

  // 窗口外的上一轮（tc=800 < windowStart=1000）：绝不可见
  message("m-old", "assistant", 800);
  toolPart("p-old", "m-old", "call_old", { status: "error", error: "stale" }, 805);

  // 本轮第一步：text → step-start → tool(completed) → step-finish
  message("m-a1", "assistant", 1100);
  stepPart("p-ss1", "m-a1", "step-start", 1100);
  textPart("p-t1", "m-a1", "第一步：查看代码", 1105);
  toolPart(
    "p-tool1",
    "m-a1",
    "call_1",
    { status: "completed", input: { command: "ls -la" } },
    1110,
  );
  stepPart("p-sf1", "m-a1", "step-finish", 1120, {
    reason: "tool-calls",
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 1 } },
  });

  // 本轮第二步：final response（应被去重）+ error 工具（协议丢 result 的实证形态）
  message("m-a2", "assistant", 1200);
  textPart("p-t2", "m-a2", "分析完成，这是最终结论。", 1205);
  toolPart("p-tool2", "m-a2", "call_2", { status: "error", error: "permission denied" }, 1210);

  db.close();
}

/** donger 侧既有审计（对账前）：call_1 有 result、call_2 只有 tool_use、call_3 已带真实入参 */
async function seedAudit(audit: InMemoryAuditStore): Promise<void> {
  const base = {
    conversationId: "conv-1",
    taskId: "task-1",
    userId: "u1",
    recordedAt: "2026-09-28T07:00:00.000Z",
  };
  let seq = 0;
  await audit.record({ ...base, seq: seq++, type: "user_message", text: "问题" });
  await audit.record({ ...base, seq: seq++, type: "session_init" });
  await audit.record({ ...base, seq: seq++, type: "llm_input", llmInput: "{}" });
  await audit.record({
    ...base,
    seq: seq++,
    type: "tool_use",
    toolName: "Bash",
    toolInput: "{}",
    toolUseId: "call_1",
  });
  await audit.record({
    ...base,
    seq: seq++,
    type: "tool_result",
    toolUseId: "call_1",
    toolOutput: "ok",
  });
  await audit.record({
    ...base,
    seq: seq++,
    type: "tool_use",
    toolName: "Bash",
    toolInput: "{}",
    toolUseId: "call_2",
  });
  await audit.record({
    ...base,
    seq: seq++,
    type: "tool_use",
    toolName: "Bash",
    toolInput: '{"command":"real"}',
    toolUseId: "call_3",
  });
  await audit.record({
    ...base,
    seq: seq++,
    type: "tool_result",
    toolUseId: "call_3",
    toolOutput: "ok",
  });
  await audit.record({
    ...base,
    seq: seq++,
    type: "result",
    resultSubtype: "success",
    text: "分析完成，这是最终结论。",
  });
}

class FakeMessageStore implements MessageStore {
  readonly added: StoredMessage[] = [];
  async add(
    conversationId: string,
    role: "user" | "bot",
    text: string,
    files: string = "[]",
    taskId?: string,
    opts?: { createdAt?: string },
  ): Promise<StoredMessage> {
    const m: StoredMessage = {
      id: `m-${this.added.length + 1}`,
      conversationId,
      role,
      text,
      files,
      ...(taskId ? { taskId } : {}),
      createdAt: opts?.createdAt ?? "now",
    };
    this.added.push(m);
    return m;
  }
  async listByConversation(conversationId: string): Promise<StoredMessage[]> {
    return this.added.filter((m) => m.conversationId === conversationId);
  }
}

describe("reconcileZcodeRound", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-reconcile-"));
    dbPath = join(dir, "db.sqlite");
    buildZcodeDb(dbPath);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // beforeEach 每次重建临时库，input 必须逐用例构造（describe 体求值时 dbPath 还是空串）
  const mkInput = (
    over: Partial<{
      zcodeDbPath: string;
      sessionId: string;
      conversationId: string;
      userId: string;
      taskId: string;
      windowStartMs: number;
      finalResponse?: string;
      dryRun?: boolean;
    }> = {},
  ) => ({
    zcodeDbPath: dbPath,
    sessionId: "sess-1",
    conversationId: "conv-1",
    userId: "u1",
    taskId: "task-1",
    windowStartMs: 1000,
    finalResponse: "分析完成，这是最终结论。",
    ...over,
  });

  it("补录叙述/回填入参/合成缺失result/逐步llm审计，一条龙", async () => {
    const audit = new InMemoryAuditStore();
    await seedAudit(audit);
    const messages = new FakeMessageStore();

    const stats = await reconcileZcodeRound(
      { messageStore: messages, auditStore: audit },
      mkInput(),
    );

    expect(stats).toMatchObject({
      textsAdded: 1,
      inputsBackfilled: 1,
      resultsSynthesized: 1,
      stepOutputsAudited: 1,
    });

    // 叙述消息：createdAt 回填 part 时间、脱敏后落库、归属本任务
    expect(messages.added.length).toBe(1);
    expect(messages.added[0]?.role).toBe("bot");
    expect(messages.added[0]?.text).toBe(redactSecrets("第一步：查看代码"));
    expect(messages.added[0]?.taskId).toBe("task-1");
    expect(messages.added[0]?.createdAt).toBe(new Date(1105).toISOString());

    const events = await audit.listByTask("task-1");
    const appended = events.filter((e) => e.seq >= 9);
    // text 行（回填 recordedAt）→ llm_output 行（逐步 tokens）→ tool_result 合成行 → 对账标记
    expect(appended.map((e) => e.type)).toEqual([
      "text",
      "llm_output",
      "tool_result",
      "zcode_reconcile",
    ]);
    expect(appended[0]?.text).toBe(redactSecrets("第一步：查看代码"));
    expect(appended[0]?.recordedAt).toBe(new Date(1105).toISOString());

    const stepOut = appended[1];
    expect(stepOut?.usage).toBeUndefined(); // usage 列不落（防审计汇总双重计数）
    expect(JSON.parse(stepOut?.llmOutput ?? "{}")).toMatchObject({
      reason: "tool-calls",
      tokens: { input: 100, output: 10 },
    });
    expect(stepOut?.durationMs).toBe(20);

    const synth = appended[2];
    expect(synth?.toolUseId).toBe("call_2");
    expect(synth?.isError).toBe(true);
    expect(synth?.toolOutput).toContain("permission denied");

    const byCall = new Map(
      events.filter((e) => e.type === "tool_use").map((e) => [e.toolUseId, e]),
    );
    expect(byCall.get("call_1")?.toolInput).toBe('{"command":"ls -la"}');
    expect(byCall.get("call_2")?.toolInput).toBe("{}"); // error 工具无 input，保持空壳
    expect(byCall.get("call_3")?.toolInput).toBe('{"command":"real"}'); // 真实入参绝不覆盖
  });

  it("幂等：重复对账被标记拦下，不产生任何重复行", async () => {
    const audit = new InMemoryAuditStore();
    await seedAudit(audit);
    const messages = new FakeMessageStore();
    await reconcileZcodeRound({ messageStore: messages, auditStore: audit }, mkInput());
    const second = await reconcileZcodeRound(
      { messageStore: messages, auditStore: audit },
      mkInput(),
    );
    expect(second.skipped).toBe("already_reconciled");
    expect(second.textsAdded).toBe(0);
    expect(messages.added.length).toBe(1);
    expect((await audit.listByTask("task-1")).length).toBe(9 + 4);
  });

  it("dryRun：只统计不写入", async () => {
    const audit = new InMemoryAuditStore();
    await seedAudit(audit);
    const messages = new FakeMessageStore();
    const stats = await reconcileZcodeRound(
      { messageStore: messages, auditStore: audit },
      mkInput({ dryRun: true }),
    );
    expect(stats.textsAdded).toBe(1);
    expect(stats.inputsBackfilled).toBe(1);
    expect(messages.added.length).toBe(0);
    expect((await audit.listByTask("task-1")).length).toBe(9);
  });

  it("zcode 库缺失/窗口无数据分别返回 missing_db / no_parts", async () => {
    const audit = new InMemoryAuditStore();
    await seedAudit(audit);
    const missing = await reconcileZcodeRound(
      { messageStore: new FakeMessageStore(), auditStore: audit },
      mkInput({ zcodeDbPath: join(dir, "nope.sqlite") }),
    );
    expect(missing.skipped).toBe("missing_db");

    const empty = await reconcileZcodeRound(
      { messageStore: new FakeMessageStore(), auditStore: audit },
      mkInput({ windowStartMs: Date.now() }),
    );
    expect(empty.skipped).toBe("no_parts");
  });
});
