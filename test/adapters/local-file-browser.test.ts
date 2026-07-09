import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileBrowser } from "../../src/adapters/local-file-browser.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { ForbiddenError, NotFoundError, PayloadTooLargeError } from "../../src/util/errors.js";

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

let tmp: string;
let db: Database.Database;
let userStore: SqliteUserStore;
let convStore: SqliteConversationStore;
let browser: LocalFileBrowser;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fb-"));
  db = new Database(":memory:");
  const usersDir = join(tmp, "users");
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  convStore = new SqliteConversationStore(db);
  convStore.migrate();
  browser = new LocalFileBrowser({ userStore, conversationStore: convStore, workspaceDir: tmp });
});
afterEach(() => {
  db.close();
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("LocalFileBrowser user scope", () => {
  it("列出 .skills / .agents / .workflows / knowledge_base 四个顶层目录", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    const tree = await browser.listTree(user.id, "user");
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual([".agents", ".skills", ".workflows", "knowledge_base"]);
  });

  it("递归展示子文件，path 为相对 scope 根", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    write(join(tmp, "users", user.id), ".skills/SKILL.md", "# hi");
    const tree = await browser.listTree(user.id, "user");
    const skills = tree.find((n) => n.name === ".skills");
    const skillMd = skills?.children?.find((c) => c.name === "SKILL.md");
    expect(skillMd?.isDir).toBe(false);
    expect(skillMd?.path).toBe(".skills/SKILL.md");
    expect(skillMd?.size).toBe(4);
  });

  it("过滤 IGNORED_NAMES 与 symlink 条目", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    const home = join(tmp, "users", user.id);
    write(home, ".skills/SKILL.md", "x");
    mkdirSync(join(home, ".skills", ".claude-plugin"), { recursive: true });
    write(home, ".skills/.claude-plugin/plugin.json", "{}");
    // symlink 指向根外
    symlinkSync(tmp, join(home, ".skills", "evil"));
    const tree = await browser.listTree(user.id, "user");
    const skills = tree.find((n) => n.name === ".skills");
    const childNames = skills?.children?.map((c) => c.name);
    expect(childNames).toContain("SKILL.md");
    expect(childNames).not.toContain(".claude-plugin");
    expect(childNames).not.toContain("evil");
  });

  it("多用户隔离：A 看不到 B 的内容", async () => {
    const a = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    const b = await userStore.getOrCreateByIdentity("internal", "u2", "bob");
    write(join(tmp, "users", b.id), ".skills/secret.md", "s");
    const tree = await browser.listTree(a.id, "user");
    const skills = tree.find((n) => n.name === ".skills");
    expect(skills?.children?.find((c) => c.name === "secret.md")).toBeUndefined();
  });

  it("readFile 返回 buffer + mime", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    write(join(tmp, "users", user.id), ".skills/SKILL.md", "# hi");
    const c = await browser.readFile(user.id, "user", join(".skills", "SKILL.md"));
    expect(c.buffer.toString("utf8")).toBe("# hi");
    expect(c.mime).toBe("text/markdown; charset=utf-8");
  });

  it("readFile 越界路径拒绝（Forbidden）", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    await expect(browser.readFile(user.id, "user", "../../memory/secret")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("readFile 不存在拒绝（NotFound）", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    await expect(
      browser.readFile(user.id, "user", join(".skills", "nope.md")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("readFile 超 maxBytes 拒绝（PayloadTooLarge）", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    write(join(tmp, "users", user.id), ".skills/big.md", "x".repeat(10));
    await expect(
      browser.readFile(user.id, "user", join(".skills", "big.md"), undefined, { maxBytes: 5 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("readFile 指向根外的 symlink 经 realpath 复校验拒绝", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    const home = join(tmp, "users", user.id);
    write(tmp, "outside.txt", "secret");
    symlinkSync(join(tmp, "outside.txt"), join(home, ".skills", "lnk.md"));
    await expect(
      browser.readFile(user.id, "user", join(".skills", "lnk.md")),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("readFile 文本类文件返回 text/plain MIME", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    write(join(tmp, "users", user.id), ".skills/app.js", "console.log(1)");
    const c = await browser.readFile(user.id, "user", join(".skills", "app.js"));
    expect(c.mime).toBe("text/plain; charset=utf-8");
  });

  it("readFile svg 返回 image/svg+xml", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    write(join(tmp, "users", user.id), ".skills/logo.svg", "<svg/>");
    const c = await browser.readFile(user.id, "user", join(".skills", "logo.svg"));
    expect(c.mime).toBe("image/svg+xml");
  });

  it("readFile 未知扩展名返回 octet-stream", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    write(join(tmp, "users", user.id), ".skills/data.bin", "\x00\x01");
    const c = await browser.readFile(user.id, "user", join(".skills", "data.bin"));
    expect(c.mime).toBe("application/octet-stream");
  });
});

describe("LocalFileBrowser runtime scope", () => {
  it("会话归属当前用户 → 列出 sessions/<convId> 下文件", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    const conv = await convStore.create(user.id, "web", "t");
    // runtime 文件在 user.homeDir/sessions/<convId>/workspace/ 下（由 RuntimeManager 创建）
    write(user.homeDir, join("sessions", conv.id, "workspace", "out.png"), "pngdata");
    const tree = await browser.listTree(user.id, "runtime", conv.id);
    const convNode = tree.find((n) => n.path === conv.id);
    expect(convNode?.children?.find((c) => c.name === "out.png")).toBeTruthy();
  });

  it("跨用户 conversationId → Forbidden", async () => {
    const a = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    const b = await userStore.getOrCreateByIdentity("internal", "u2", "bob");
    const conv = await convStore.create(b.id, "web", "t");
    await expect(browser.listTree(a.id, "runtime", conv.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("runtime 缺 conversationId → Forbidden（参数非法）", async () => {
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    await expect(browser.listTree(user.id, "runtime")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
