import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillInstaller } from "../../src/adapters/local-skill-installer.js";
import { SkillRepoSyncService } from "../../src/adapters/skill-repo-sync.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { SqliteUserSkillRepoStore } from "../../src/adapters/sqlite-user-skill-repo-store.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";

let root: string;
let db: Database.Database;
let packStore: SqliteSkillPackStore;
let repoStore: SqliteUserSkillRepoStore;
let installer: LocalSkillInstaller;
let service: SkillRepoSyncService;
let remoteUrl: string;
let homeDir: string;
let credentialFilled = true;

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { stdio: "pipe", ...(cwd ? { cwd } : {}) });
}

function makeCredentialSets(): CredentialSetStore {
  return {
    getFilledValues: async () =>
      credentialFilled
        ? [
            {
              userId: "u1",
              code: "gitee-pat",
              values: { access_token: "dummy-token" },
              createdAt: "",
              updatedAt: "",
            },
          ]
        : [],
  } as unknown as CredentialSetStore;
}

function checkRemote(): { manifest: { packs: Array<{ slug: string }> }; skillDoc?: string } {
  const dir = join(root, `check-${crypto.randomUUID()}`);
  git(["clone", "--depth", "1", remoteUrl, dir]);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    packs: Array<{ slug: string }>;
  };
  const packSlug = manifest.packs[0]?.slug;
  const docPath = packSlug
    ? join(dir, "packs", packSlug, "skills", "alpha", "SKILL.md")
    : undefined;
  return {
    manifest,
    ...(docPath && existsSync(docPath) ? { skillDoc: readFileSync(docPath, "utf8") } : {}),
  };
}

async function installSamplePack(): Promise<void> {
  await installer.installFromPaste("u1", {
    slug: "demo",
    content: '---\nname: alpha\ndescription: "测试技能"\n---\n# 正文\n',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-repo-sync-"));
  db = new Database(":memory:");
  packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  repoStore = new SqliteUserSkillRepoStore(db);
  repoStore.migrate();
  homeDir = join(root, "home");
  installer = new LocalSkillInstaller({ packStore, getHomeDir: () => homeDir });
  const remoteDir = join(root, "remote.git");
  git(["init", "--bare", "--initial-branch=main", remoteDir]);
  remoteUrl = remoteDir;
  credentialFilled = true;
  service = new SkillRepoSyncService({
    repoStore,
    packStore,
    credentialSets: makeCredentialSets(),
    getHomeDir: () => homeDir,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SkillRepoSyncService", () => {
  it("未配置仓库时同步与测试均失败提示", async () => {
    const outcome = await service.syncNow("u1");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("未配置");
    const probe = await service.verify({ id: "u1" });
    expect(probe.ok).toBe(false);
  });

  it("首同步到空仓库：镜像 manifest/pack/.meta 并留提交", async () => {
    await installSamplePack();
    await repoStore.upsert("u1", {
      repoUrl: remoteUrl,
      credentialCode: "gitee-pat",
      branch: "main",
      enabled: true,
    });
    const outcome = await service.syncNow("u1");
    expect(outcome.ok).toBe(true);
    const remote = checkRemote();
    expect(remote.manifest.packs.map((p) => p.slug)).toEqual(["demo"]);
    expect(remote.skillDoc).toContain("# 正文");
  });

  it("变更驱动：更新/启停/卸载逐次同步均收敛到远端", { timeout: 30_000 }, async () => {
    await installSamplePack();
    await repoStore.upsert("u1", {
      repoUrl: remoteUrl,
      credentialCode: "gitee-pat",
      branch: "main",
      enabled: true,
    });
    await service.syncNow("u1");

    // 优化（updateSkillDoc）
    const pack = await packStore.getPackBySlug("u1", "demo");
    expect(pack).toBeDefined();
    if (!pack) return;
    await installer.updateSkillDoc(
      "u1",
      pack.id,
      "alpha",
      '---\nname: alpha\ndescription: "v2"\n---\n# v2\n',
    );
    service.onChanged("u1");
    await service.idle("u1");
    let remote = checkRemote();
    expect(remote.skillDoc).toContain("# v2");

    // 停用 pack（管理状态入 .meta.json/manifest）
    await packStore.setPackEnabled("u1", pack.id, false);
    await service.syncNow("u1");
    remote = checkRemote();
    expect(remote.manifest.packs[0]?.slug).toBe("demo");

    // 卸载 → 镜像移除
    await installer.uninstall("u1", pack.id);
    await service.syncNow("u1");
    remote = checkRemote();
    expect(remote.manifest.packs).toHaveLength(0);
    expect(remote.skillDoc).toBeUndefined();
  });

  it("无变更时同步跳过提交且状态 ok", async () => {
    await installSamplePack();
    await repoStore.upsert("u1", {
      repoUrl: remoteUrl,
      credentialCode: "gitee-pat",
      branch: "main",
      enabled: true,
    });
    expect((await service.syncNow("u1")).ok).toBe(true);
    const again = await service.syncNow("u1");
    expect(again.ok).toBe(true);
    expect(again.message).toContain("无变更");
  });

  it("凭证缺失：同步失败落 lastSyncStatus，不抛出", async () => {
    credentialFilled = false;
    await installSamplePack();
    await repoStore.upsert("u1", {
      repoUrl: remoteUrl,
      credentialCode: "gitee-pat",
      branch: "main",
      enabled: true,
    });
    const outcome = await service.syncNow("u1");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("access_token");
    const cfg = await repoStore.get("u1");
    expect(cfg?.lastSyncStatus).toBe("failed");
    expect(cfg?.lastSyncError).toContain("access_token");
  });

  it("verify 连通性测试：本地 bare 仓可通", async () => {
    await repoStore.upsert("u1", {
      repoUrl: remoteUrl,
      credentialCode: "gitee-pat",
      branch: "main",
      enabled: true,
    });
    const probe = await service.verify({ id: "u1" });
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain("空仓库");
  });
});
