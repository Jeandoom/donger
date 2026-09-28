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
  const absPath = join("workspace-src", "app.ts");

  beforeEach(async () => {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const usersDir = mkdtempSync(join(tmpdir(), "fc-users-"));
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
    const runtimeRoot = join(usersDir, owner.id, "sessions", conv.id, "workspace");
    mkdirSync(join(runtimeRoot, "workspace-src"), { recursive: true });
    writeFileSync(join(runtimeRoot, absPath), "const a = 1;\nconst c = 3;\n", "utf8");

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

  it("列表：Bash 被忽略；Write/Edit 聚合为 created + adds/removes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: Array<{
        path: string;
        displayPath: string;
        language: string;
        firstOp: string;
        adds: number;
        removes: number;
        writes: number;
        edits: number;
      }>;
    };
    expect(body.files).toHaveLength(1);
    const f = body.files[0];
    expect(f?.displayPath).toBe("workspace-src/app.ts");
    expect(f?.language).toBe("typescript");
    expect(f?.firstOp).toBe("created");
    expect(f?.adds).toBe(3);
    expect(f?.removes).toBe(1);
    expect(f?.writes).toBe(1);
    expect(f?.edits).toBe(1);
  });

  it("详情：分段 diff 行（del/add 带行号）", async () => {
    const list = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      })
    ).json()) as { files: Array<{ path: string }> };
    const path = list.files[0]?.path ?? "";
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/file-changes/detail?path=${encodeURIComponent(path)}`,
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

  it("内容：读活文件；未知路径 404", async () => {
    const list = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/file-changes`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      })
    ).json()) as { files: Array<{ path: string }> };
    const path = list.files[0]?.path ?? "";
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/file-changes/content?path=${encodeURIComponent(path)}`,
      { headers: { Authorization: `Bearer ${ownerJwt}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("const a = 1;\nconst c = 3;\n");

    const missing = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/file-changes/detail?path=${encodeURIComponent("D:/nope/x.ts")}`,
      { headers: { Authorization: `Bearer ${ownerJwt}` } },
    );
    expect(missing.status).toBe(404);
  });
});
