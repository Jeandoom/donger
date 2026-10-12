import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { LocalFileBrowser } from "../../src/adapters/local-file-browser.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteMcpTokenStore } from "../../src/adapters/sqlite-mcp-token-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * 会话文件变更端点 e2e（spec 2026-09-24-mcp-auth-files-design §4）：
 * audit 写入类 tool_use 还原 → 列表/分段 diff/当前内容三端点 + 属主隔离。
 */

describe("GET /api/conversations/:id/file-changes*", () => {
  let db: Database.Database;
  let web: WebChannel;
  let port = 0;
  let ownerJwt: string;
  let otherJwt: string;
  let convId: string;
  let usersDir = "";
  let runtimeRoot = "";
  let outsidePath = "";
  const absPath = join("workspace-src", "app.ts");

  beforeEach(async () => {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    usersDir = mkdtempSync(join(tmpdir(), "fc-users-"));
    const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    userStore.migrate();
    const owner = await userStore.getOrCreateByIdentity("internal", "fc-owner", "属主");
    const other = await userStore.getOrCreateByIdentity("internal", "fc-other", "旁人");
    ownerJwt = (await sessionStore.create(owner.id)).token;
    otherJwt = (await sessionStore.create(other.id)).token;

    const convStore = new SqliteConversationStore(db);
    convStore.migrate();
    const conv = await convStore.create(owner.id, "web", "变更会话");
    convId = conv.id;

    const wsDir = mkdtempSync(join(tmpdir(), "fc-ws-"));
    // 会话闲聊形态的 runtime 根：<homeDir>/sessions/<convId>/workspace
    runtimeRoot = join(usersDir, owner.id, "sessions", conv.id, "workspace");
    mkdirSync(join(runtimeRoot, "workspace-src"), { recursive: true });
    writeFileSync(join(runtimeRoot, absPath), "const a = 1;\nconst c = 3;\n", "utf8");
    // 工作区外路径（模拟宿主任意位置的历史写入）：列表可见 diff，但键脱敏且当前内容不可读
    outsidePath = join(wsDir, "..", "outside-secret-report.md");

    const auditStore = new InMemoryAuditStore({
      conversationOwner: async (id) => (await convStore.get(id))?.userId,
    });
    const mk = (input: unknown, toolName: string, at: string) => ({
      id: `e-${at}-${toolName}`,
      conversationId: conv.id,
      taskId: "t1",
      userId: owner.id,
      seq: 0,
      type: "tool_use" as const,
      toolName,
      toolInput: JSON.stringify(input),
      recordedAt: at,
    });
    await auditStore.record(
      mk(
        { file_path: join(runtimeRoot, absPath), content: "const a = 1;\nconst b = 2;\n" },
        "Write",
        "2026-09-24T10:00:00Z",
      ),
    );
    await auditStore.record(
      mk(
        {
          file_path: join(runtimeRoot, absPath),
          old_string: "const b = 2;",
          new_string: "const b = 20;",
        },
        "Edit",
        "2026-09-24T11:00:00Z",
      ),
    );
    await auditStore.record(mk({ command: "echo hi" }, "Bash", "2026-09-24T12:00:00Z"));
    await auditStore.record(
      mk({ file_path: outsidePath, content: "宿主侧历史写入\n" }, "Write", "2026-09-24T12:30:00Z"),
    );

    web = new WebChannel({
      port: 0,
      workspaceDir: wsDir,
      sessionStore,
      userStore,
      conversationStore: convStore,
      auditStore,
      fileBrowser: new LocalFileBrowser({
        workspaceDir: wsDir,
        userStore,
        conversationStore: convStore,
      }),
      mcpTokenStore: new SqliteMcpTokenStore(db),
    });
    web.onMessage(() => {});
    await web.ready();
    port = web.boundPort ?? 0;
    if (!port) throw new Error("no port");
  });

  afterEach(() => {
    web?.stop?.();
    db?.close();
  });

  it("无 token 401；旁人 403（owner 守卫）", async () => {
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`)).status,
    ).toBe(401);
    const other = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`, {
      headers: { Authorization: `Bearer ${otherJwt}` },
    });
    expect(other.status).toBe(403);
  });

  it("列表：Bash 被忽略；Write/Edit 聚合；出口键脱敏不含宿主绝对路径", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // 不泄漏断言：响应里不出现 runtime 根/用户根/工作区外路径等宿主绝对路径
    expect(raw).not.toContain(runtimeRoot);
    expect(raw).not.toContain(usersDir);
    expect(raw).not.toContain(outsidePath);
    const body = JSON.parse(raw) as {
      files: Array<{
        key: string;
        displayPath: string;
        language: string;
        firstOp: string;
        adds: number;
        removes: number;
        writes: number;
        edits: number;
      }>;
    };
    expect(body.files).toHaveLength(2);
    const wsFile = body.files.find((f) => f.displayPath === "workspace-src/app.ts");
    expect(wsFile?.key).toBe("workspace-src/app.ts");
    expect(wsFile?.language).toBe("typescript");
    expect(wsFile?.firstOp).toBe("created");
    expect(wsFile?.adds).toBe(3);
    expect(wsFile?.removes).toBe(1);
    expect(wsFile?.writes).toBe(1);
    expect(wsFile?.edits).toBe(1);
    // 工作区外文件：键与展示只到（外部）+ 文件名
    const outFile = body.files.find((f) => f.key.startsWith("（外部）"));
    expect(outFile?.key).toBe("（外部）outside-secret-report.md");
    expect(outFile?.displayPath).toBe("（外部）outside-secret-report.md");
  });

  it("详情：按 key 查分段 diff 行（del/add 带行号）", async () => {
    const list = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      })
    ).json()) as { files: Array<{ key: string; displayPath: string }> };
    const key = list.files.find((f) => f.displayPath === "workspace-src/app.ts")?.key ?? "";
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/file-changes/detail?key=${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${ownerJwt}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      segments: Array<{ tool: string; kind: string; rows: Array<{ type: string; text: string }> }>;
    };
    expect(body.segments).toHaveLength(2);
    const editRows = body.segments[1]?.rows.filter((r) => r.type !== "ctx") ?? [];
    // Edit 段行号相对 old_string/new_string（审计入参不含文件级行偏移）
    expect(editRows).toEqual([
      { type: "del", oldNo: 1, text: "const b = 2;" },
      { type: "add", newNo: 1, text: "const b = 20;" },
    ]);
  });

  it("内容：工作区内按 key 读活文件；工作区外/未知 key 一律 404", async () => {
    const list = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      })
    ).json()) as { files: Array<{ key: string; displayPath: string }> };
    const key = list.files.find((f) => f.displayPath === "workspace-src/app.ts")?.key ?? "";
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/file-changes/content?key=${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${ownerJwt}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("const a = 1;\nconst c = 3;\n");

    const outsideKey = list.files.find((f) => f.key.startsWith("（外部）"))?.key ?? "";
    const outside = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/file-changes/content?key=${encodeURIComponent(outsideKey)}`,
      { headers: { Authorization: `Bearer ${ownerJwt}` } },
    );
    expect(outside.status).toBe(404);

    const missing = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/file-changes/detail?key=${encodeURIComponent("nope/x.ts")}`,
      { headers: { Authorization: `Bearer ${ownerJwt}` } },
    );
    expect(missing.status).toBe(404);
  });
});
