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
    expect(
      migrationNeeded({
        oldDataDir: oldData,
        newDbPath: newDb,
        newWorkspaceDir: newWs,
        sentinelPath: sentinel,
      }),
    ).toBe(true);
  });

  it("migrateWorkspace：只写 sentinel，旧数据不再迁移", () => {
    seedOld();
    const done = migrateWorkspace({
      oldDataDir: oldData,
      newDbPath: newDb,
      newWorkspaceDir: newWs,
      sentinelPath: sentinel,
    });
    expect(done).toBe(true);
    // 旧数据不再迁移
    expect(existsSync(newDb)).toBe(false);
    expect(existsSync(join(newWs))).toBe(false);
    // 只写 sentinel
    expect(existsSync(sentinel)).toBe(true);
  });

  it("幂等：sentinel 存在 → 不再迁", () => {
    seedOld();
    migrateWorkspace({
      oldDataDir: oldData,
      newDbPath: newDb,
      newWorkspaceDir: newWs,
      sentinelPath: sentinel,
    });
    expect(
      migrationNeeded({
        oldDataDir: oldData,
        newDbPath: newDb,
        newWorkspaceDir: newWs,
        sentinelPath: sentinel,
      }),
    ).toBe(false);
  });
});
