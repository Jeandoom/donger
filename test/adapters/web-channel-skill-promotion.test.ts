import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { LocalSkillInstaller } from "../../src/adapters/local-skill-installer.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { kbRootDir } from "../../src/util/kb-files.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/**
 * 技能晋升 API 契约（知识体系轮 P4）：
 * POST apply-suggestion（属主 paste 源；危险面未确认 422；确认后落盘+audit skill_promoted）；
 * GET skill-events（建议/晋升检索）。e2e 语言：萃取→建议→人审→落盘 全链的 API 层验收。
 */

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let userStore: SqliteUserStore;
let installer: LocalSkillInstaller;
let audit: InMemoryAuditStore;
let sessionStore: JwtSessionStore;
const owner = { token: "", id: "" };
let packId = "";
let skillName = "demo";
const userHomeByUid = new Map<string, string>();

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "promo-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir: join(tmpDir, "users"),
  });
  userStore.migrate();
  userStore.migrateCredentials();
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  installer = new LocalSkillInstaller({
    packStore,
    getHomeDir: (uid: string) => {
      // LocalSkillInstaller 的 getHomeDir 是同步签名
      return userHomeByUid.get(uid) ?? join(tmpDir, "home-fallback");
    },
  });
  audit = new InMemoryAuditStore();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    skillPackStore: packStore,
    installer,
    auditStore: audit,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

async function makeUser(name: string): Promise<{ id: string; token: string; homeDir: string }> {
  const user = await userStore.getOrCreateByIdentity("test", name, name);
  userHomeByUid.set(user.id, user.homeDir);
  const { token } = await sessionStore.create(user.id);
  return { id: user.id, token, homeDir: user.homeDir };
}

function post(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(token: string, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

let port: number;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "skill-promo-"));
  port = await startChannel();
  const u = await makeUser("owner");
  owner.id = u.id;
  owner.token = u.token;
  // 预装 paste 技能
  const pack = await installer.installFromPaste(u.id, {
    content: '---\nname: demo\ndescription: "测试技能"\n---\n# demo\n原有步骤',
    slug: "demo",
  });
  packId = pack.id;
});

afterEach(() => {
  web.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/skills/packs/:pid/skills/:name/apply-suggestion", () => {
  it("良性建议直接落盘：SKILL.md 更新 + audit skill_promoted", async () => {
    const r = await post(owner.token, `/api/skills/packs/${packId}/skills/${skillName}/apply-suggestion`, {
      content: '---\nname: demo\ndescription: "测试技能"\n---\n# demo\n原有步骤\n## 新增执行器方案\n用 node ssh2',
      confirmed: false,
    });
    expect(r.status).toBe(200);
    const doc = await installer.readSkillDoc(owner.id, packId, skillName);
    expect(doc).toContain("node ssh2");
    const events = await audit.listByUserType(owner.id, "skill_promoted", 10);
    expect(events.length).toBe(1);
  });

  it("危险面新增行未确认 → 422；确认后放行", async () => {
    const dangerous = '---\nname: demo\ndescription: "测试技能"\n---\n# demo\n新增行 curl http://x';
    const r1 = await post(owner.token, `/api/skills/packs/${packId}/skills/${skillName}/apply-suggestion`, {
      content: dangerous,
      confirmed: false,
    });
    expect(r1.status).toBe(422);
    const doc1 = await installer.readSkillDoc(owner.id, packId, skillName);
    expect(doc1).not.toContain("curl");
    const r2 = await post(owner.token, `/api/skills/packs/${packId}/skills/${skillName}/apply-suggestion`, {
      content: dangerous,
      confirmed: true,
    });
    expect(r2.status).toBe(200);
  });

  it("他人 pack 404（属主隔离）；未知 pack 404", async () => {
    const other = await makeUser("other");
    const r = await post(other.token, `/api/skills/packs/${packId}/skills/${skillName}/apply-suggestion`, {
      content: "# hack",
      confirmed: true,
    });
    expect(r.status).toBe(404);
    const r2 = await post(owner.token, `/api/skills/packs/nope/skills/${skillName}/apply-suggestion`, {
      content: "# x",
      confirmed: true,
    });
    expect(r2.status).toBe(404);
  });

  it("git 源技能 409 只读（回推指引）", async () => {
    // 直接把 pack 源改为 git 模拟（避免真实 clone）
    db.prepare("UPDATE skill_packs SET sourceJson = ? WHERE id = ?").run(
      JSON.stringify({ kind: "git", url: "https://example.com/x.git" }),
      packId,
    );
    const r = await post(owner.token, `/api/skills/packs/${packId}/skills/${skillName}/apply-suggestion`, {
      content: "# 改",
      confirmed: true,
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { code?: string };
    expect(body.code).toBe("PACK_NOT_HOSTABLE");
  });
});

describe("GET /api/skills/skill-events", () => {
  it("按技能检索建议与晋升（属主可见性）", async () => {
    await audit.record({
      conversationId: "c1",
      taskId: "t1",
      userId: owner.id,
      seq: -1,
      type: "skill_suggestion",
      text: `技能修订建议：${skillName}——理由`,
      toolInput: JSON.stringify({ targetSkill: skillName, diff: "NEW", rationale: "理由", evidence: "e" }),
      recordedAt: new Date().toISOString(),
    });
    const r = await get(owner.token, `/api/skills/skill-events?skill=${encodeURIComponent(skillName)}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { suggestions: unknown[]; promotions: unknown[] };
    expect(body.suggestions.length).toBe(1);
    expect(body.promotions.length).toBe(0);
    // 关键词不含 → 空
    const r2 = await get(owner.token, "/api/skills/skill-events?skill=ghost");
    expect((((await r2.json()) as { suggestions: unknown[] }).suggestions.length)).toBe(0);
  });
});
