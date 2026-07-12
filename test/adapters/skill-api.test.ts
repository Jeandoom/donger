import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalSkillInstaller } from "../../src/adapters/local-skill-installer.js";
import {
  handleDeleteCredential,
  handleInstall,
  handleListCredentials,
  handleListPacks,
  handleSetCredential,
  handleSetPackEnabled,
  handleUninstall,
} from "../../src/adapters/skill-api.js";
import { SqliteCredentialStore } from "../../src/adapters/sqlite-credential-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

let db: Database.Database;
let deps: ReturnType<typeof makeDeps>;
let homeDir: string;

function makeDeps() {
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  const credentialStore = new SqliteCredentialStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialStore.migrate();
  homeDir = mkdtempSync(join(tmpdir(), "skillapi-"));
  const installer = new LocalSkillInstaller({
    packStore,
    getHomeDir: (uid) => join(homeDir, uid),
  });
  return { packStore, installer, credentialStore };
}

beforeEach(() => {
  db = new Database(":memory:");
  deps = makeDeps();
});

describe("skill-api", () => {
  it("handleInstall(paste) + handleListPacks 含 skills + 凭证命中状态", async () => {
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

  it("handleListCredentials / handleSetCredential / handleDeleteCredential 带 usedBy", async () => {
    await handleInstall(
      "u1",
      {
        source: {
          kind: "paste",
          slug: "demo",
          content: "---\nname: a\ndescription: d\n---\n",
        },
      },
      deps,
      // 注：paste 安装不产生 credentials（无 donger.manifest.json），usedBy 应为空数组
    );
    const set = await handleSetCredential("u1", { key: "K", value: "v", label: "L" }, deps);
    expect(set.status).toBe(200);
    const list = await handleListCredentials("u1", {}, deps);
    const creds = (list.json as { credentials: Array<{ key: string; usedBy: string[] }> })
      .credentials;
    expect(creds[0]?.key).toBe("K");
    expect(creds[0]?.usedBy).toEqual([]);
    const del = await handleDeleteCredential("u1", { key: "K" }, deps);
    expect(del.status).toBe(200);
    const list2 = await handleListCredentials("u1", {}, deps);
    expect((list2.json as { credentials: unknown[] }).credentials).toHaveLength(0);
  });
});
