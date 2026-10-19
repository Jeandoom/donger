import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * 会话文件目录沙箱 e2e（2026-10-19 串会话轮）：绑定智能体的会话，文件树与内容
 * 读取根下沉到本会话 worktree 区（<agent workspace>/worktrees/<convId>，与
 * RuntimeManager 物化位同源）——兄弟会话 worktree 与共享根散文件不可见、不可读；
 * 沙箱缺失（未绑仓库/被 GC）回退共享根；未注入解析器（GIT_SESSION_WORKTREE=false
 * 口径）维持共享根现状。HTTP 全链路：路由守卫 → JWT 认证 → FileBrowser。
 */

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("GET /api/files/* 会话沙箱", () => {
  let db: Database.Database;
  let web: WebChannel;
  let webFallback: WebChannel;
  let port = 0;
  let portFallback = 0;
  let ownerJwt: string;
  let otherJwt: string;
  let convA = "";
  let convB = "";
  let convC = "";
  let usersDir = "";

  beforeEach(async () => {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    usersDir = mkdtempSync(join(tmpdir(), "fsb-users-"));
    const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    userStore.migrate();
    const owner = await userStore.getOrCreateByIdentity("internal", "fsb-owner", "属主");
    const other = await userStore.getOrCreateByIdentity("internal", "fsb-other", "旁人");
    ownerJwt = (await sessionStore.create(owner.id)).token;
    otherJwt = (await sessionStore.create(other.id)).token;

    const convStore = new SqliteConversationStore(db);
    convStore.migrate();
    convA = (await convStore.createWithAgent(owner.id, "web", "A", "agent-e1")).id;
    convB = (await convStore.createWithAgent(owner.id, "web", "B", "agent-e1")).id;
    convC = (await convStore.createWithAgent(owner.id, "web", "C", "agent-e1")).id;
    const otherConv = await convStore.createWithAgent(other.id, "web", "X", "agent-e1");

    const home = owner.homeDir;
    // 共享根散文件（cwd=agent workspace，产物跨会话延续的设计内产物）
    write(home, join("agents", "agent-e1", "workspace", "loose.md"), "shared");
    // 本会话 A 与兄弟会话 B 的 worktree（物化器契约：<workspace>/worktrees/<convId>/repos/<name>）
    write(
      home,
      join("agents", "agent-e1", "workspace", "worktrees", convA, "repos", "proj", "a.md"),
      "mine",
    );
    write(
      home,
      join("agents", "agent-e1", "workspace", "worktrees", convB, "repos", "proj", "b.md"),
      "sibling",
    );

    const mkBrowser = (sandboxed: boolean): LocalFileBrowser =>
      new LocalFileBrowser({
        workspaceDir: usersDir,
        userStore,
        conversationStore: convStore,
        // 与 src/index.ts 生产装配同款
        conversationSandboxDir: sandboxed
          ? ({ runtimeRoot, conversationId }) => join(runtimeRoot, "worktrees", conversationId)
          : undefined,
      });

    web = new WebChannel({
      port: 0,
      workspaceDir: usersDir,
      sessionStore,
      userStore,
      conversationStore: convStore,
      auditStore: new InMemoryAuditStore({
        conversationOwner: async (id) => (await convStore.get(id))?.userId,
      }),
      fileBrowser: mkBrowser(true),
      mcpTokenStore: new SqliteMcpTokenStore(db),
    });
    web.onMessage(() => {});
    await web.ready();
    port = web.boundPort ?? 0;
    if (!port) throw new Error("no port");

    // 未注入沙箱（GIT_SESSION_WORKTREE=false 口径）的对照实例
    webFallback = new WebChannel({
      port: 0,
      workspaceDir: usersDir,
      sessionStore,
      userStore,
      conversationStore: convStore,
      auditStore: new InMemoryAuditStore({
        conversationOwner: async (id) => (await convStore.get(id))?.userId,
      }),
      fileBrowser: mkBrowser(false),
      mcpTokenStore: new SqliteMcpTokenStore(db),
    });
    webFallback.onMessage(() => {});
    await webFallback.ready();
    portFallback = webFallback.boundPort ?? 0;
    if (!portFallback) throw new Error("no fallback port");

    // 旁人会话根（跨用户断言用，避免未初始化引用）
    write(
      other.homeDir,
      join("agents", "agent-e1", "workspace", "worktrees", otherConv.id, "repos", "proj", "x.md"),
      "theirs",
    );
  });

  afterEach(() => {
    web?.stop?.();
    webFallback?.stop?.();
    db?.close();
    if (existsSync(usersDir)) rmSync(usersDir, { recursive: true, force: true });
  });

  function treeUrl(p: number, conversationId: string): string {
    return `http://127.0.0.1:${p}/api/files/tree?scope=runtime&conversationId=${conversationId}&token=${ownerJwt}`;
  }
  function contentUrl(p: number, conversationId: string, path: string): string {
    return `http://127.0.0.1:${p}/api/files/content?scope=runtime&conversationId=${conversationId}&path=${encodeURIComponent(path)}&token=${ownerJwt}`;
  }

  it("沙箱已物化：树只含本会话 worktree，兄弟会话与共享散文件不可见", async () => {
    const res = await fetch(treeUrl(port, convA));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { nodes: Array<{ name: string; path: string }> };
    expect(body.nodes.map((n) => n.name)).toEqual(["repos"]);
    expect(raw).toContain("repos/proj/a.md");
    expect(raw).not.toContain("loose.md");
    expect(raw).not.toContain("b.md");
    expect(raw).not.toContain(convB);
  });

  it("内容读取同根：本会话文件 200；兄弟文件 404；越界 403", async () => {
    const mine = await fetch(contentUrl(port, convA, "repos/proj/a.md"));
    expect(mine.status).toBe(200);
    expect(await mine.text()).toBe("mine");

    // 兄弟会话文件在本会话沙箱内不存在（路径合法但落空）
    const sibling = await fetch(contentUrl(port, convA, "repos/proj/b.md"));
    expect(sibling.status).toBe(404);

    const escape = await fetch(contentUrl(port, convA, "../../loose.md"));
    expect(escape.status).toBe(403);
  });

  it("沙箱缺失（未绑仓库/被 GC）→ 回退共享根（旧口径：worktrees/ 目录如实露出）", async () => {
    const res = await fetch(treeUrl(port, convC));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ name: string }> };
    expect(body.nodes.map((n) => n.name).sort()).toEqual(["loose.md", "worktrees"]);
  });

  it("未注入解析器（GIT_SESSION_WORKTREE=false）→ 维持共享根现状", async () => {
    const res = await fetch(treeUrl(portFallback, convA));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { nodes: Array<{ name: string }> };
    expect(body.nodes.map((n) => n.name)).toContain("loose.md");
    // 旧口径下兄弟 worktree 仍然在列（对照，证明沙箱确实改变了行为）
    expect(raw).toContain("b.md");
  });

  it("跨用户 conversationId → 403；无 token → 401", async () => {
    const cross = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?scope=runtime&conversationId=${convA}&token=${otherJwt}`,
    );
    expect(cross.status).toBe(403);
    const anon = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?scope=runtime&conversationId=${convA}`,
    );
    expect(anon.status).toBe(401);
  });
});
