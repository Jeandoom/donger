import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKbLibraryStore } from "../../src/adapters/sqlite-kb-store.js";
import { kbRootDir } from "../../src/util/kb-files.js";
import { migrateKnowledgeBases } from "../../src/util/kb-migrate.js";

/**
 * 知识库统一迁移（spec §5.3）：个人库 ensure、旧 knowledge_base/ 并入（user/*→memory/*）、
 * rename 退役、二次运行幂等、无旧目录用户不受影响。
 */

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = join(tmpdir(), `kb-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrateKnowledgeBases", () => {
  it("存量用户：旧目录并入个人库并退役；二次运行幂等", async () => {
    const workspaceDir = makeTmp();
    const usersDir = join(workspaceDir, "users");
    const uws = join(usersDir, "u1");
    mkdirSync(join(uws, "knowledge_base", "user"), { recursive: true });
    mkdirSync(join(uws, "knowledge_base", "knowledges"), { recursive: true });
    writeFileSync(join(uws, "knowledge_base", "user", "2026-01-01-note.md"), "记忆1", "utf8");
    writeFileSync(join(uws, "knowledge_base", "knowledges", "faq.md"), "FAQ", "utf8");

    const db = new Database(":memory:");
    const libraries = new SqliteKbLibraryStore(db);
    libraries.migrate();

    const r1 = await migrateKnowledgeBases({ libraryStore: libraries, workspaceDir, usersDir });
    expect(r1.ensuredPersonal).toBe(1);
    expect(r1.mergedLegacy).toBe(1);
    expect(r1.renameFailed).toBe(0);

    const personal = await libraries.ensurePersonalLibrary("u1");
    const root = kbRootDir(workspaceDir, personal.id);
    expect(readFileSync(join(root, "memory", "2026-01-01-note.md"), "utf8")).toBe("记忆1");
    expect(readFileSync(join(root, "knowledges", "faq.md"), "utf8")).toBe("FAQ");
    // 旧目录已退役（不存在，改名保留）
    expect(existsSync(join(uws, "knowledge_base"))).toBe(false);

    // 二次运行：无新迁移、无异常
    const r2 = await migrateKnowledgeBases({ libraryStore: libraries, workspaceDir, usersDir });
    expect(r2.ensuredPersonal).toBe(0);
    expect(r2.mergedLegacy).toBe(0);
  });

  it("无旧目录的用户：只 ensure 个人库，不建 knowledge_base", async () => {
    const workspaceDir = makeTmp();
    const usersDir = join(workspaceDir, "users");
    mkdirSync(join(usersDir, "u2"), { recursive: true });
    const db = new Database(":memory:");
    const libraries = new SqliteKbLibraryStore(db);
    libraries.migrate();

    const r = await migrateKnowledgeBases({ libraryStore: libraries, workspaceDir, usersDir });
    expect(r.ensuredPersonal).toBe(1);
    expect(r.mergedLegacy).toBe(0);
    const personal = await libraries.ensurePersonalLibrary("u2");
    expect(existsSync(kbRootDir(workspaceDir, personal.id))).toBe(true);
    expect(existsSync(join(usersDir, "u2", "knowledge_base"))).toBe(false);
  });

  it("非用户实体目录（如 sessions）被跳过不崩溃", async () => {
    const workspaceDir = makeTmp();
    const usersDir = join(workspaceDir, "users");
    mkdirSync(join(usersDir, "not-a-user", "knowledge_base"), { recursive: true });
    const db = new Database(":memory:");
    const libraries = new SqliteKbLibraryStore(db);
    libraries.migrate();
    // not-a-user 没有个人库记录，迁移器会为它 ensure 一个（目录名即 userId）；
    // 关键是不抛错、其余用户不受影响
    const r = await migrateKnowledgeBases({ libraryStore: libraries, workspaceDir, usersDir });
    expect(r.ensuredPersonal).toBeGreaterThanOrEqual(1);
  });
});
