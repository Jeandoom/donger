import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunOptions } from "../../src/index.js";

describe("buildRunOptions", () => {
  it("cwd = sessions/<convId>/（懒创建）+ workspaceRoot = homeDir + pluginPaths 含 .skills", () => {
    const userWs = mkdtempSync(join(tmpdir(), "bro-"));
    const opts = buildRunOptions({
      cfg: {
        workspaceDir: "/ws",
        superpowersPluginPath: undefined as string | undefined,
        llm: { model: "m", baseUrl: "u", authToken: "t" },
      } as never,
      user: { id: "u1", homeDir: userWs } as never,
      task: { id: "t1" } as never,
      convId: "conv-1",
    });
    expect(existsSync(join(userWs, "sessions", "plain", "conv-1"))).toBe(true);
    expect(opts.workspaceRoot).toBe(userWs);
    expect(opts.cwd).toBe(join(userWs, "sessions", "plain", "conv-1"));
    expect(opts.pluginPaths).toContain(join(userWs, ".skills"));
  });
});
