import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureRuntimeDir,
  initUserWorkspace,
  runtimeDir,
  userWorkspaceDir,
} from "../../src/util/workspace.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ws-"));
}

describe("workspace util", () => {
  it("userWorkspaceDir = <ws>/users/<id>", () => {
    expect(userWorkspaceDir("/ws", "u1")).toBe(join("/ws", "users", "u1"));
  });

  it("runtimeDir = <userWs>/<root>/<entity>/<conv>", () => {
    expect(runtimeDir("/ws/users/u1", "skill_root", "bug-analysis", "conv-9")).toBe(
      join("/ws", "users", "u1", "skill_root", "bug-analysis", "conv-9"),
    );
  });

  it("initUserWorkspace 建三类目录 + plugin.json", () => {
    const root = tmp();
    const userWs = join(root, "u1");
    initUserWorkspace(userWs);
    for (const d of [
      ".skills",
      ".agents",
      ".workflows",
      "sessions",
      "skill_root",
      "agent_root",
      "workflow_root",
    ]) {
      expect(existsSync(join(userWs, d))).toBe(true);
    }
    for (const d of ["user", "skills", "agents", "workflows", "knowledges"]) {
      expect(existsSync(join(userWs, "knowledge_base", d))).toBe(true);
    }
    expect(existsSync(join(userWs, ".skills", ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("ensureRuntimeDir 懒创建（之前不存在）", () => {
    const root = tmp();
    const dir = ensureRuntimeDir(join(root, "u1"), "sessions", "plain", "conv-1");
    expect(existsSync(dir)).toBe(true);
    expect(dir).toBe(join(root, "u1", "sessions", "plain", "conv-1"));
  });
});
