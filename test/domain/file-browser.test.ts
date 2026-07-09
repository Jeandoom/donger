import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IGNORED_NAMES,
  resolveWithinRoots,
  scopeRoots,
  USER_SUBDIRS,
} from "../../src/domain/file-browser.js";

describe("file-browser domain", () => {
  it("USER_SUBDIRS 为 4 个用户子目录", () => {
    expect([...USER_SUBDIRS]).toEqual([".skills", ".agents", ".workflows", "knowledge_base"]);
  });

  it("IGNORED_NAMES 含 .claude-plugin / .git / node_modules", () => {
    expect(IGNORED_NAMES.has(".claude-plugin")).toBe(true);
    expect(IGNORED_NAMES.has(".git")).toBe(true);
    expect(IGNORED_NAMES.has("node_modules")).toBe(true);
  });

  it("scopeRoots(user) 返回 homeDir 下 4 个精确根，不含 memory/sessions", () => {
    const roots = scopeRoots("user", { homeDir: "/h", workspaceDir: "/w" });
    expect(roots).toEqual([
      join("/h", ".skills"),
      join("/h", ".agents"),
      join("/h", ".workflows"),
      join("/h", "knowledge_base"),
    ]);
    expect(roots.every((r) => !r.includes("memory") && !r.includes("sessions"))).toBe(true);
  });

  it("scopeRoots(runtime) 返回 homeDir/sessions/<conversationId>/workspace", () => {
    const roots = scopeRoots("runtime", {
      homeDir: "/h",
      workspaceDir: "/w",
      conversationId: "c1",
    });
    // runtime 文件在 user.homeDir/sessions/<convId>/workspace/ 下（由 RuntimeManager 创建）
    expect(roots).toEqual([join("/h", "sessions", "c1", "workspace")]);
  });

  it("scopeRoots(runtime) 缺 conversationId 抛错", () => {
    expect(() => scopeRoots("runtime", { homeDir: "/h", workspaceDir: "/w" })).toThrow();
  });

  it("resolveWithinRoots 根内放行", () => {
    const r = resolveWithinRoots([join("/h", ".skills")], "SKILL.md");
    expect(r.ok).toBe(true);
  });

  it("resolveWithinRoots 拒绝 .. 穿越", () => {
    const root = join("/h", ".skills");
    expect(resolveWithinRoots([root], "../../memory/secret").ok).toBe(false);
    expect(resolveWithinRoots([root], "../knowledge_base/x").ok).toBe(false);
  });

  it("resolveWithinRoots 拒绝 URL 编码穿越", () => {
    const root = join("/h", ".skills");
    expect(resolveWithinRoots([root], "..%2F..%2Fetc%2Fpasswd").ok).toBe(false);
  });

  it("resolveWithinRoots 拒绝跨根", () => {
    const roots = [join("/h", ".skills")];
    expect(resolveWithinRoots(roots, join("/h", "knowledge_base", "x")).ok).toBe(false);
  });

  it("resolveWithinRoots 根内深层放行、越界拒绝", () => {
    const root = join("/h", ".skills");
    expect(resolveWithinRoots([root], "a/b/c.md").ok).toBe(true);
    expect(resolveWithinRoots([root], "../.agents/x").ok).toBe(false);
  });

  it("resolveWithinRoots 多根命中任一放行", () => {
    const roots = [join("/h", ".skills"), join("/h", "knowledge_base")];
    expect(resolveWithinRoots(roots, "user/note.md").ok).toBe(true);
  });
});
