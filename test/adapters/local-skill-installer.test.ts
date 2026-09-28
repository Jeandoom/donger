import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillInstaller } from "../../src/adapters/local-skill-installer.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import { type GitProcessCredential, runGit } from "../../src/util/git-process.js";

let db: Database.Database;
let packStore: SqliteSkillPackStore;
let installer: LocalSkillInstaller;
let homeDir: string;
const gitRoots: string[] = [];

beforeEach(() => {
  db = new Database(":memory:");
  packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  homeDir = mkdtempSync(join(tmpdir(), "home-"));
  installer = new LocalSkillInstaller({
    packStore,
    getHomeDir: (uid) => join(homeDir, uid),
    // 测试用本地临时仓库作 git 源（生产 HTTP 入口默认拒绝本地路径）
    allowLocalGitSource: true,
  });
});
afterEach(() => {
  db.close();
  for (const root of gitRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalSkillInstaller", () => {
  it("paste：合成 plugin 目录 + 单 skill + 扫描入库", async () => {
    const pack = await installer.installFromPaste("u1", {
      content: '---\nname: hello\ndescription: "打招呼"\n---\n# hello',
      slug: "hello",
    });
    expect(pack.slug).toBe("hello");
    expect(pack.name).toBe("hello");
    expect(
      existsSync(join(homeDir, "u1", ".skills", "hello", ".claude-plugin", "plugin.json")),
    ).toBe(true);
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
    await installer.installFromPaste("u1", {
      content: "---\nname: x\ndescription: d\n---\n",
      slug: "x",
    });
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
    writeFileSync(
      join(shared, "fw", "skills", "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\n",
    );
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
    writeFileSync(
      join(shared, "fw", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "fw" }),
    );
    mkdirSync(join(shared, "fw", "skills", "s"), { recursive: true });
    writeFileSync(
      join(shared, "fw", "skills", "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\n",
    );
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
    execSync("git -c user.email=a@b.c -c user.name=a add -A", { cwd: src });
    execSync("git -c user.email=a@b.c -c user.name=a commit -qm init", { cwd: src });
    const pack = await installer.installFromGit("u1", { url: src, slug: "gitpack" });
    expect(pack.name).toBe("gitpack");
    expect((await packStore.listSkills("u1", pack.id)).map((s) => s.name)).toEqual(["g"]);
    expect(pack.source.kind).toBe("git");
  });

  it("git：支持无 plugin.json 的多级 skills 仓库与 subPath", async () => {
    const src = mkdtempSync(join(tmpdir(), "git-skills-src-"));
    gitRoots.push(src);
    const first = join(src, "skills", "database", "first-skill");
    const second = join(src, "skills", "database", "second-skill");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(
      join(first, "SKILL.md"),
      "---\nname: first-skill\ndescription: |\n  第一行\n  第二行\n---\n# first",
    );
    writeFileSync(
      join(second, "SKILL.md"),
      "---\nname: second-skill\ndescription: second\n---\n# second",
    );
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: src });
    execSync("git -c user.email=a@b.c -c user.name=a add -A", { cwd: src });
    execSync("git -c user.email=a@b.c -c user.name=a commit -qm init", { cwd: src });

    const pack = await installer.installFromGit("u1", {
      url: src,
      slug: "aiops-skills",
      subPath: "skills/database",
    });

    expect(pack.name).toBe("aiops-skills");
    expect(
      existsSync(join(homeDir, "u1", ".skills", "aiops-skills", ".claude-plugin", "plugin.json")),
    ).toBe(true);
    const skills = await packStore.listSkills("u1", pack.id);
    expect(skills.map((s) => s.name)).toEqual(["first-skill", "second-skill"]);
    expect(skills[0]?.description).toBe("第一行\n第二行");
    expect(skills[0]?.relativePath).toBe("skills/database/first-skill/SKILL.md");

    await expect(
      installer.installFromGit("u1", {
        url: src,
        slug: "aiops-skills-invalid",
        subPath: "../../outside",
      }),
    ).rejects.toThrow("技能目录不存在或非法");
    expect(existsSync(join(homeDir, "u1", ".skills", "aiops-skills-invalid"))).toBe(false);
  }, 15_000);

  // ---- 技能工坊：readSkillDoc / updateSkillDoc ----

  it("readSkillDoc：读 paste pack 的 SKILL.md 全文；技能不存在报错", async () => {
    const pack = await installer.installFromPaste("u1", {
      content: `---
name: hello
description: "打招呼"
---
# hello 正文`,
      slug: "hello",
    });
    const doc = await installer.readSkillDoc("u1", pack.id, "hello");
    expect(doc).toContain("# hello 正文");
    await expect(installer.readSkillDoc("u1", pack.id, "nope")).rejects.toThrow("无技能");
  });

  it("updateSkillDoc：正常更新落盘 + 描述刷新 + 启停状态保留", async () => {
    const pack = await installer.installFromPaste("u1", {
      content: `---
name: hello
description: "旧描述"
---
# v1`,
      slug: "hello",
    });
    const first = (await packStore.listSkills("u1", pack.id))[0];
    if (!first) throw new Error("listSkills 为空");
    await packStore.setSkillEnabled("u1", first.id, false);
    const updated = await installer.updateSkillDoc(
      "u1",
      pack.id,
      "hello",
      `---
name: hello
description: "新描述"
---
# v2 修订`,
    );
    const skills = await packStore.listSkills("u1", updated.id);
    expect(skills[0]?.description).toBe("新描述");
    expect(skills[0]?.enabled).toBe(false);
    const doc = await installer.readSkillDoc("u1", updated.id, "hello");
    expect(doc).toContain("# v2 修订");
  });

  it("updateSkillDoc：builtin 拒改 / git 源拒改 / name 不一致拒改 / 他人 pack 不可见", async () => {
    const shared = mkdtempSync(join(tmpdir(), "b-"));
    mkdirSync(join(shared, "fw", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(shared, "fw", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "fw" }),
    );
    mkdirSync(join(shared, "fw", "skills", "s"), { recursive: true });
    writeFileSync(
      join(shared, "fw", "skills", "s", "SKILL.md"),
      `---
name: s
description: d
---
`,
    );
    const builtin = await installer.installBuiltin("u1", "fw", join(shared, "fw"));
    await expect(
      installer.updateSkillDoc(
        "u1",
        builtin.id,
        "s",
        `---
name: s
description: d
---
x`,
      ),
    ).rejects.toThrow("预装技能不可修改");

    const src = mkdtempSync(join(tmpdir(), "git-src-"));
    mkdirSync(join(src, "skills", "g"), { recursive: true });
    writeFileSync(
      join(src, "skills", "g", "SKILL.md"),
      `---
name: g
description: d
---
`,
    );
    const { execSync } = await import("node:child_process");
    execSync(
      "git init -q && git -c user.email=a@b.c -c user.name=a add -A && git -c user.email=a@b.c -c user.name=a commit -qm i",
      { cwd: src },
    );
    const gitPack = await installer.installFromGit("u1", { url: src, slug: "gp" });
    await expect(
      installer.updateSkillDoc(
        "u1",
        gitPack.id,
        "g",
        `---
name: g
description: d
---
x`,
      ),
    ).rejects.toThrow("git 源技能");

    const paste = await installer.installFromPaste("u1", {
      content: `---
name: x
description: d
---
`,
      slug: "x",
    });
    await expect(
      installer.updateSkillDoc(
        "u1",
        paste.id,
        "x",
        `---
name: y
description: d
---
`,
      ),
    ).rejects.toThrow("不一致");

    await expect(packStore.getPack("u2", paste.id)).resolves.toBeUndefined();
  });
});

// ---- git 凭证鉴权（GitLab/JihuLab/Gitee 私有仓库安装）----

function commitAll(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"], {
    cwd,
  });
}

describe("LocalSkillInstaller git 凭证鉴权", () => {
  const templates = new Map<string, { kind: "generic" | "git"; repoUrl?: string }>();
  const values = new Map<string, Record<string, string>>();
  const gitCalls: Array<{ args: string[]; credential?: GitProcessCredential }> = [];
  let credInstaller: LocalSkillInstaller;

  function makeCredentialSets(): CredentialSetStore {
    return {
      getTemplate: async (code) => {
        const t = templates.get(code);
        if (!t) return undefined;
        return {
          code,
          name: code,
          kind: t.kind,
          ...(t.repoUrl ? { repoUrl: t.repoUrl } : {}),
          keySpecs: [],
          createdBy: "u1",
          createdAt: "",
          updatedAt: "",
        };
      },
      getFilledValues: async (uid, codes) =>
        codes
          .filter((c) => values.has(c))
          .map((c) => ({
            userId: uid,
            code: c,
            values: values.get(c) ?? {},
            createdAt: "",
            updatedAt: "",
          })),
    } as unknown as CredentialSetStore;
  }

  function makeSrcRepo(): string {
    const src = mkdtempSync(join(tmpdir(), "git-cred-src-"));
    gitRoots.push(src);
    mkdirSync(join(src, "skills", "g"), { recursive: true });
    writeFileSync(join(src, "skills", "g", "SKILL.md"), '---\nname: g\ndescription: "cred"\n---\n');
    commitAll(src);
    return src;
  }

  beforeEach(() => {
    templates.clear();
    values.clear();
    gitCalls.length = 0;
    credInstaller = new LocalSkillInstaller({
      packStore,
      getHomeDir: (uid) => join(homeDir, uid),
      allowLocalGitSource: true,
      credentialSets: makeCredentialSets(),
      gitRunner: (args, credential, timeout) => {
        gitCalls.push({ args, ...(credential ? { credential } : {}) });
        return runGit(args, credential, timeout);
      },
    });
  });

  it("勾选凭证安装：AskPass 注入 + credentialCode 落 source + 更新复用", {
    timeout: 15_000,
  }, async () => {
    const src = makeSrcRepo();
    templates.set("gl-pat", { kind: "git" });
    values.set("gl-pat", { access_token: "tok-123" });
    const pack = await credInstaller.installFromGit("u1", {
      url: src,
      slug: "cred-pack",
      credentialCode: "gl-pat",
    });
    expect(pack.source.credentialCode).toBe("gl-pat");
    expect(gitCalls[0]?.args[0]).toBe("clone");
    expect(gitCalls[0]?.credential).toEqual({ username: "oauth2", accessToken: "tok-123" });

    gitCalls.length = 0;
    await credInstaller.update("u1", pack.id);
    expect(gitCalls[0]?.args).toContain("pull");
    expect(gitCalls[0]?.credential).toEqual({ username: "oauth2", accessToken: "tok-123" });
  });

  it("凭证校验：模板不存在 / kind 非 git / 未填 token / repoUrl 不一致", async () => {
    const src = makeSrcRepo();
    templates.set("gen", { kind: "generic" });
    templates.set("bound", { kind: "git", repoUrl: "https://gitlab.com/other/repo" });
    templates.set("empty", { kind: "git" });
    values.set("empty", {});
    await expect(
      credInstaller.installFromGit("u1", { url: src, slug: "a", credentialCode: "nope" }),
    ).rejects.toThrow("凭证模板不存在");
    await expect(
      credInstaller.installFromGit("u1", { url: src, slug: "b", credentialCode: "gen" }),
    ).rejects.toThrow("kind=git");
    await expect(
      credInstaller.installFromGit("u1", { url: src, slug: "c", credentialCode: "empty" }),
    ).rejects.toThrow("access_token");
    await expect(
      credInstaller.installFromGit("u1", {
        url: "https://gitlab.com/other/repo2",
        slug: "d",
        credentialCode: "bound",
      }),
    ).rejects.toThrow("不一致");
  });

  it("git 地址校验：URL 内嵌凭证与 option 注入拒绝", async () => {
    await expect(
      credInstaller.installFromGit("u1", {
        url: "https://user:tok@gitlab.com/g/r.git",
        slug: "x",
      }),
    ).rejects.toThrow("HTTPS");
    await expect(
      credInstaller.installFromGit("u1", { url: "--upload-pack=evil", slug: "y" }),
    ).rejects.toThrow("非法");
  });

  it("鉴权失败：错误信息给勾选凭证引导，安装目录清理", async () => {
    templates.set("gl-pat", { kind: "git" });
    values.set("gl-pat", { access_token: "tok-123" });
    const failing = new LocalSkillInstaller({
      packStore,
      getHomeDir: (uid) => join(homeDir, uid),
      credentialSets: makeCredentialSets(),
      gitRunner: async () => ({
        code: 128,
        stdout: "",
        stderr: "fatal: Authentication failed for 'https://gitlab.example.com/g/r.git/'",
        timedOut: false,
      }),
    });
    await expect(
      failing.installFromGit("u1", {
        url: "https://gitlab.example.com/g/r",
        slug: "auth-fail",
        credentialCode: "gl-pat",
      }),
    ).rejects.toThrow(/鉴权未通过[\s\S]*勾选 git 凭证/);
    expect(existsSync(join(homeDir, "u1", ".skills", "auth-fail"))).toBe(false);
    await expect(packStore.getPackBySlug("u1", "auth-fail")).resolves.toBeUndefined();
  });
});
