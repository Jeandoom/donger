import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalSkillInstaller } from "../../src/adapters/local-skill-installer.js";
import {
  handleInstall,
  handleListPacks,
  handleSetPackEnabled,
  handleUninstall,
} from "../../src/adapters/skill-api.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";

let db: Database.Database;
let deps: ReturnType<typeof makeDeps>;
let homeDir: string;

function makeDeps() {
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  homeDir = mkdtempSync(join(tmpdir(), "skillapi-"));
  const installer = new LocalSkillInstaller({
    packStore,
    getHomeDir: (uid) => join(homeDir, uid),
  });
  return { packStore, installer };
}

beforeEach(() => {
  db = new Database(":memory:");
  deps = makeDeps();
});

describe("skill-api", () => {
  it("handleInstall(paste) + handleListPacks 含 skills", async () => {
    const r = await handleInstall(
      "u1",
      {
        source: {
          kind: "paste",
          slug: "demo",
          content: '---\nname: alpha\ndescription: "a"\n---\n',
        },
      },
      deps,
    );
    expect(r.status).toBe(200);
    const pack = (r.json as { pack: { id: string } }).pack;
    const list = await handleListPacks("u1", {}, deps);
    const packs = (list.json as { packs: Array<{ slug: string; skills: unknown[] }> }).packs;
    expect(packs).toHaveLength(1);
    expect(packs[0]?.skills).toHaveLength(1);
    void pack;
  });

  it("handleInstall 不支持的来源 → 400", async () => {
    const r = await handleInstall("u1", { source: { kind: "ftp" } }, deps);
    expect(r.status).toBe(400);
  });

  it("handleSetPackEnabled / handleUninstall", async () => {
    const installed = await handleInstall(
      "u1",
      { source: { kind: "paste", slug: "demo", content: "---\nname: a\ndescription: d\n---\n" } },
      deps,
    );
    const id = (installed.json as { pack: { id: string } }).pack.id;
    const dis = await handleSetPackEnabled("u1", { id, enabled: false }, deps);
    expect(dis.status).toBe(200);
    const del = await handleUninstall("u1", { id }, deps);
    expect(del.status).toBe(200);
    expect((await handleListPacks("u1", {}, deps)).json).toEqual({ packs: [] });
  });
});
