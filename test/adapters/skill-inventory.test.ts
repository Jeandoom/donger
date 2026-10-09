// 技能全量清单/agent 级落点/提升托管/回装/marketplace 派生/脱敏扫描
// （specs/2026-10-09-skills-git-hosting-design.md M1-M3 后端行为）

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalSkillInstaller } from "../../src/adapters/local-skill-installer.js";
import {
  handleHostSkill,
  handleInstallToAgent,
  handleInventory,
} from "../../src/adapters/skill-api.js";
import { handleRepoInstall } from "../../src/adapters/skill-repo-api.js";
import { SkillRepoSyncService } from "../../src/adapters/skill-repo-sync.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { SqliteUserSkillRepoStore } from "../../src/adapters/sqlite-user-skill-repo-store.js";
import type { Agent } from "../../src/domain/agent.js";
import type { AgentStore } from "../../src/ports/agent-store.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";

let root: string;
let homeDir: string;
let db: Database.Database;
let packStore: SqliteSkillPackStore;
let repoStore: SqliteUserSkillRepoStore;
let installer: LocalSkillInstaller;
let syncService: SkillRepoSyncService;
let remoteUrl: string;
const syncCalls: string[] = [];

/** 凭证桩：模板 kind=git（repoUrl 不绑定=一凭一仓校验跳过）+ 用户值含 access_token */
const credentialSets = {
  getFilledValues: async () => [
    {
      userId: "u1",
      code: "gitee-pat",
      values: { access_token: "dummy-token" },
      createdAt: "",
      updatedAt: "",
    },
  ],
  getTemplate: async (code: string) => ({
    code,
    name: code,
    kind: "git",
    keySpecs: [{ key: "access_token", required: true }],
  }),
} as unknown as CredentialSetStore;

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { stdio: "pipe", ...(cwd ? { cwd } : {}) });
}

function makeAgentStore(agents: Agent[]): AgentStore {
  return {
    get: async (id: string) => agents.find((a) => a.id === id),
    listByOwner: async (ownerId: string) => agents.filter((a) => a.ownerId === ownerId),
  } as unknown as AgentStore;
}

function agentFixture(id: string, ownerId = "u1"): Agent {
  return {
    id,
    ownerId,
    name: `agent-${id}`,
    systemPrompt: "",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    connectorIds: [],
    knowledgeBaseIds: [],
    credentials: [],
    gitRepositories: [],
    gitAllowShellGit: false,
    extensionDirectories: [],
    scenario: "ops",
    defaultPermissionMode: "ask_before_change",
    conversationScope: { enabled: false, agentIds: [] },
    feedbackScope: { enabled: false },
    version: 1,
    createdAt: "",
    updatedAt: "",
  } as unknown as Agent;
}

function writeWorkspaceSkill(agentId: string, name: string, content?: string): void {
  const dir = join(homeDir, "agents", agentId, "workspace", ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    content ?? `---\nname: ${name}\ndescription: 工作区技能 ${name}\n---\n# 正文\n`,
  );
}

function deps() {
  return {
    packStore,
    installer,
    agentStore: makeAgentStore([agentFixture("a1"), agentFixture("a2"), agentFixture("a9", "u2")]),
    getHomeDir: async (uid: string) => (uid === "u1" ? homeDir : join(root, `home-${uid}`)),
    skillRepoSync: { onChanged: (uid: string) => syncCalls.push(uid) },
  };
}

async function installSamplePack(): Promise<string> {
  const r = await installer.installFromPaste("u1", {
    slug: "demo",
    content: '---\nname: alpha\ndescription: "测试技能"\n---\n# 正文\n',
  });
  return r.id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-inventory-"));
  homeDir = join(root, "home-u1");
  mkdirSync(homeDir, { recursive: true });
  db = new Database(":memory:");
  packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  repoStore = new SqliteUserSkillRepoStore(db);
  repoStore.migrate();
  installer = new LocalSkillInstaller({
    packStore,
    getHomeDir: (uid) => (uid === "u1" ? homeDir : join(root, `home-${uid}`)),
    allowLocalGitSource: true,
    credentialSets,
  });
  // 裸远端（push 镜像目标）
  remoteUrl = join(root, "remote.git");
  git(["init", "--bare", remoteUrl]);
  syncService = new SkillRepoSyncService({
    repoStore,
    packStore,
    credentialSets,
    getHomeDir: (uid) => (uid === "u1" ? homeDir : join(root, `home-${uid}`)),
  });
  syncCalls.length = 0;
});

describe("skill inventory / agent 级落点 / 托管闭环", () => {
  it("inventory 三源归一：packs + agent 工作区 + 托管标记", async () => {
    await installSamplePack();
    writeWorkspaceSkill("a1", "ops-check");
    // 伪造仓库 manifest（镜像产物）→ demo 托管
    const cache = join(homeDir, ".skill-repo-cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(
      join(cache, "manifest.json"),
      JSON.stringify({ source: "donger-skills", packs: [{ slug: "demo" }] }),
    );

    const r = await handleInventory("u1", {}, deps());
    expect(r.status).toBe(200);
    const data = r.json as {
      records: Array<{
        id: string;
        origin: string;
        name: string;
        hosted: boolean;
        agentName?: string;
        packSlug?: string;
      }>;
      repo: { configured: boolean; hostedSlugs: string[] };
    };
    const alpha = data.records.find((x) => x.name === "alpha");
    expect(alpha).toMatchObject({ origin: "pack", packSlug: "demo", hosted: true });
    const ws = data.records.find((x) => x.name === "ops-check");
    expect(ws).toMatchObject({
      origin: "agent",
      id: "agent-skills:ops-check",
      agentId: "a1",
      agentName: "agent-a1",
      hosted: false,
      enabled: true,
    });
    expect(data.repo.hostedSlugs).toEqual(["demo"]);
    expect(data.repo.configured).toBe(true);
  });

  it("install-to-agent：pack 技能复制到工作区；同名 409、覆盖、越权 404", async () => {
    const packId = await installSamplePack();
    const d = deps();
    const ok = await handleInstallToAgent(
      "u1",
      { agentId: "a1", from: { kind: "pack", packId, skill: "alpha" } },
      d,
    );
    expect(ok.status).toBe(200);
    const doc = join(
      homeDir,
      "agents",
      "a1",
      "workspace",
      ".agents",
      "skills",
      "alpha",
      "SKILL.md",
    );
    expect(existsSync(doc)).toBe(true);

    const dup = await handleInstallToAgent(
      "u1",
      { agentId: "a1", from: { kind: "pack", packId, skill: "alpha" } },
      d,
    );
    expect(dup.status).toBe(409);
    expect((dup.json as { code?: string }).code).toBe("SKILL_EXISTS");

    const over = await handleInstallToAgent(
      "u1",
      { agentId: "a1", from: { kind: "pack", packId, skill: "alpha" }, overwrite: true },
      d,
    );
    expect(over.status).toBe(200);

    // 越权：别人的 agent → 404（不泄漏存在性）
    const foreign = await handleInstallToAgent(
      "u1",
      { agentId: "a9", from: { kind: "pack", packId, skill: "alpha" } },
      d,
    );
    expect(foreign.status).toBe(404);
  });

  it("提升托管：工作区技能 → paste 包（onChanged 触发）→ 重复提升走更新不重建", async () => {
    writeWorkspaceSkill("a1", "ops-check");
    const d = deps();
    const first = await handleHostSkill("u1", { agentId: "a1", skill: "ops-check" }, d);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ action: "created", packSlug: "ops-check" });
    expect(syncCalls).toEqual(["u1"]);
    expect(await packStore.getPackBySlug("u1", "ops-check")).toBeTruthy();

    // 修改工作区文件后再次提升 → 更新同一个包
    writeWorkspaceSkill("a1", "ops-check", "---\nname: ops-check\ndescription: v2\n---\n");
    const second = await handleHostSkill("u1", { agentId: "a1", skill: "ops-check" }, d);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ action: "updated", packSlug: "ops-check" });
    expect(syncCalls).toEqual(["u1", "u1"]);
  });

  it("提升托管：同名 git 源 pack → 409 不覆盖", async () => {
    // 上游本地 git 仓库（skills/ops-check/SKILL.md）→ 装 git 包占住 slug
    const upstream = join(root, "upstream-git");
    mkdirSync(join(upstream, "skills", "ops-check"), { recursive: true });
    writeFileSync(
      join(upstream, "skills", "ops-check", "SKILL.md"),
      "---\nname: ops-check\ndescription: git 上游\n---\n",
    );
    git(["init", upstream]);
    git(["-C", upstream, "add", "-A"]);
    git(["-C", upstream, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    await installer.installFromGit("u1", { url: upstream, slug: "ops-check" });

    writeWorkspaceSkill("a1", "ops-check");
    const r = await handleHostSkill("u1", { agentId: "a1", skill: "ops-check" }, deps());
    expect(r.status).toBe(409);
    expect((r.json as { code?: string }).code).toBe("PACK_NOT_HOSTABLE");
  });

  it("回装：镜像 push 后从仓库以 git 源装回；已存在默认 409、replace 守卫", { timeout: 30_000 }, async () => {
    await repoStore.upsert("u1", {
      repoUrl: remoteUrl,
      credentialCode: "gitee-pat",
      branch: "master",
      enabled: true,
    });
    await installSamplePack();
    const syncOutcome = await syncService.syncNow("u1");
    expect(syncOutcome.ok).toBe(true);

    const d = {
      repoStore,
      sync: syncService,
      packStore,
      installer,
      credentialSets: undefined,
    };
    // 补缺语义：先卸载本地 paste 包，再从仓库回装为 git 源
    const local = (await packStore.listPacks("u1")).find((p) => p.slug === "demo");
    await installer.uninstall("u1", local?.id ?? "");
    const first = await handleRepoInstall("u1", { slug: "demo" }, d);
    expect(first.status).toBe(200);
    const pack = (first.json as { pack: { id: string; source: { kind: string } } }).pack;
    expect(pack.source.kind).toBe("git");

    // 再次回装 → 409；replace=true → git 源守卫拒绝（上游已有历史由「更新」负责）
    const dup = await handleRepoInstall("u1", { slug: "demo" }, d);
    expect(dup.status).toBe(409);
    const guarded = await handleRepoInstall("u1", { slug: "demo", replace: true }, d);
    expect(guarded.status).toBe(400);

    // paste 包占 slug：默认 409（PACK_EXISTS）
    await installer.installFromPaste("u1", {
      slug: "fresh",
      content: "---\nname: beta\ndescription: b\n---\n",
    });
    const conflict = await handleRepoInstall("u1", { slug: "fresh" }, d);
    expect(conflict.status).toBe(409);
    expect((conflict.json as { code?: string }).code).toBe("PACK_EXISTS");
  });

  it("镜像仓库派生 marketplace.json + 脱敏告警", { timeout: 30_000 }, async () => {
    await repoStore.upsert("u1", {
      repoUrl: remoteUrl,
      credentialCode: "gitee-pat",
      branch: "master",
      enabled: true,
    });
    await installer.installFromPaste("u1", {
      slug: "leaky",
      content:
        '---\nname: leaky\ndescription: "d"\n---\npassword: "supersecret99" sk-abcdefghijklmnopqrst\n',
    });
    const outcome = await syncService.syncNow("u1");
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("脱敏告警");

    const check = join(root, `check-${crypto.randomUUID()}`);
    git(["clone", "--depth", "1", remoteUrl, check]);
    const marketplace = JSON.parse(
      readFileSync(join(check, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(marketplace.name).toBe("donger-skills");
    expect(marketplace.plugins[0]).toMatchObject({ name: "leaky", source: "./packs/leaky" });
    void rmSync;
  });
});
