import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateWorkspace, migrationNeeded } from "../../src/util/workspace-migrate.js";

let root: string;
let oldData: string;
let newWs: string;
let newDb: string;
let sentinel: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mig-"));
  oldData = join(root, "data");
  newWs = join(root, "ws");
  newDb = join(root, "donger.db");
  sentinel = join(root, ".migrated");
});

function seedOld() {
  mkdirSync(join(oldData, "users", "u1", "memory"), { recursive: true });
  writeFileSync(join(oldData, "users", "u1", "memory", "a.md"), "# s\n\ndetail\n", "utf8");
  writeFileSync(join(oldData, "donger.db"), "sqlite-ish", "utf8");
}

describe("workspace migration", () => {
  it("migrationNeeded：旧存在且无 sentinel → true", () => {
    seedOld();
    expect(migrationNeeded({ oldDataDir: oldData, newDbPath: newDb, newWorkspaceDir: newWs, sentinelPath: sentinel })).toBe(true);
  });

  it("migrateWorkspace：DB+memory 迁，worktree 不迁，data.bak 留底，sentinel 写", () => {
    seedOld();
    mkdirSync(join(oldData, "users", "u1", "repos", ".worktrees", "t1"), { recursive: true });
    const done = migrateWorkspace({ oldDataDir: oldData, newDbPath: newDb, newWorkspaceDir: newWs, sentinelPath: sentinel });
    expect(done).toBe(true);
    expect(existsSync(newDb)).toBe(true);
    expect(existsSync(join(newWs, "users", "u1", "knowledge_base", "user", "a.md"))).toBe(true);
    expect(existsSync(join(newWs, "users", "u1", ".skills", ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(newWs, "users", "u1", "repos"))).toBe(false);
    expect(existsSync(join(root, "data.bak"))).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("幂等：sentinel 存在 → 不再迁", () => {
    seedOld();
    migrateWorkspace({ oldDataDir: oldData, newDbPath: newDb, newWorkspaceDir: newWs, sentinelPath: sentinel });
    expect(migrationNeeded({ oldDataDir: oldData, newDbPath: newDb, newWorkspaceDir: newWs, sentinelPath: sentinel })).toBe(false);
  });
});
