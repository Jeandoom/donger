import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillInstaller } from "../../src/adapters/local-skill-installer.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";

let db: Database.Database;
let packStore: SqliteSkillPackStore;
let installer: LocalSkillInstaller;
let homeDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  homeDir = mkdtempSync(join(tmpdir(), "home-"));
  installer = new LocalSkillInstaller({
    packStore,
    getHomeDir: (uid) => join(homeDir, uid),
  });
});
afterEach(() => db.close());

describe("LocalSkillInstaller", () => {
  it("paste：合成 plugin 目录 + 单 skill + 扫描入库", async () => {
    const pack = await installer.installFromPaste("u1", {
      content: '---\nname: hello\ndescription: "打招呼"\n---\n# hello',
      slug: "hello",
    });
    expect(pack.slug).toBe("hello");
    expect(pack.name).toBe("hello");
    expect(existsSync(join(homeDir, "u1", ".skills", "hello", ".claude-plugin", "plugin.json"))).toBe(true);
    const skills = await packStore.listSkills("u1", pack.id);
    expect(skills.map((s) => s.name)).toEqual(["hello"]);
  });

  it("upload：用 filename 作 slug 提示", async () => {
    const pack = await installer.installFromUpload("u1", {
      filename: "My Skill.md",
      content: '---\nname: my-skill\ndescription: "x"\n---\n',
    });
    expect(pack.slug).toBe("my-skill");
    expect(pack.source.kind).toBe("upload");
  });

  it("slug 冲突自动 -2 去重", async () => {
    await installer.installFromPaste("u1", { content: "---\nname: x\ndescription: d\n---\n", slug: "x" });
    const p2 = await installer.installFromPaste("u1", {
      content: "---\nname: x\ndescription: d\n---\n",
      slug: "x",
    });
    expect(p2.slug).toBe("x-2");
  });

  it("恶意 slug 被净化为安全 slug（防路径穿越）", async () => {
    const pack = await installer.installFromPaste("u1", {
      content: "---\nname: x\ndescription: d\n---\n",
      slug: "../evil/PATH",
    });
    expect(pack.slug).toMatch(/^[a-z0-9-]+$/);
    // 安装目录必须落在 .skills/ 内，未逃逸
    const dir = join(homeDir, "u1", ".skills", pack.slug);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(homeDir, "u1", "evil"))).toBe(false);
  });

  it("builtin：登记共享只读路径，不落用户目录", async () => {
    const shared = mkdtempSync(join(tmpdir(), "builtin-"));
    mkdirSync(join(shared, "fw", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(shared, "fw", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "fw", version: "1.0.0" }),
    );
    mkdirSync(join(shared, "fw", "skills", "s"), { recursive: true });
    writeFileSync(join(shared, "fw", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    const pack = await installer.installBuiltin("u1", "fw", join(shared, "fw"));
    expect(pack.builtin).toBe(true);
    expect(pack.installedPath).toBe(join(shared, "fw"));
    expect(existsSync(join(homeDir, "u1", ".skills", "fw"))).toBe(false);
    expect((await packStore.listSkills("u1", pack.id)).map((s) => s.name)).toEqual(["s"]);
  });

  it("uninstall 删目录 + DB 行", async () => {
    const pack = await installer.installFromPaste("u1", {
      content: "---\nname: x\ndescription: d\n---\n",
      slug: "x",
    });
    await installer.uninstall("u1", pack.id);
    expect(existsSync(join(homeDir, "u1", ".skills", "x"))).toBe(false);
    expect(await packStore.getPack("u1", pack.id)).toBeUndefined();
  });

  it("builtin pack 禁止 uninstall", async () => {
    const shared = mkdtempSync(join(tmpdir(), "b-"));
    mkdirSync(join(shared, "fw", ".claude-plugin"), { recursive: true });
    writeFileSync(join(shared, "fw", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fw" }));
    mkdirSync(join(shared, "fw", "skills", "s"), { recursive: true });
    writeFileSync(join(shared, "fw", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    const pack = await installer.installBuiltin("u1", "fw", join(shared, "fw"));
    await expect(installer.uninstall("u1", pack.id)).rejects.toThrow();
  });

  it("git：真实临时仓库 clone + 扫描", async () => {
    const src = mkdtempSync(join(tmpdir(), "git-src-"));
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    writeFileSync(join(src, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "gitpack" }));
    mkdirSync(join(src, "skills", "g"), { recursive: true });
    writeFileSync(join(src, "skills", "g", "SKILL.md"), '---\nname: g\ndescription: "gg"\n---\n');
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: src });
    execSync('git -c user.email=a@b.c -c user.name=a add -A', { cwd: src });
    execSync('git -c user.email=a@b.c -c user.name=a commit -qm init', { cwd: src });
    const pack = await installer.installFromGit("u1", { url: src, slug: "gitpack" });
    expect(pack.name).toBe("gitpack");
    expect((await packStore.listSkills("u1", pack.id)).map((s) => s.name)).toEqual(["g"]);
    expect(pack.source.kind).toBe("git");
  });
});
