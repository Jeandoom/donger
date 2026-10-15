import { describe, expect, it } from "vitest";
import {
  matchesToolWhitelist,
  runStaticToolGuards,
  type StaticToolGuardScope,
} from "../../src/adapters/tool-call-guards.js";

type Opts = StaticToolGuardScope["opts"];

function guardOpts(allowedTools: string[] | undefined): Opts {
  return {
    cwd: ".",
    allowedTools,
    gitAllowShellGit: true,
    egressAllowDomains: [],
    bashAllowlist: undefined,
    kbWriteGuardRoots: [],
    sensitiveReadPolicy: undefined,
    workspaceRoot: undefined,
    allowedWriteRoots: [],
    readOnlyRoots: [],
  };
}

describe("matchesToolWhitelist", () => {
  it("工具全名条目：精确匹配", () => {
    expect(matchesToolWhitelist("Read", ["Read"])).toBe(true);
    expect(matchesToolWhitelist("Bash", ["Read"])).toBe(false);
  });

  it("MCP 服务器前缀条目：放行该服务器全部工具（KB 管家形态）", () => {
    const whitelist = ["mcp__donger-kb"];
    expect(matchesToolWhitelist("mcp__donger-kb__kb_list", whitelist)).toBe(true);
    expect(matchesToolWhitelist("mcp__donger-kb__kb_read", whitelist)).toBe(true);
    expect(matchesToolWhitelist("mcp__donger-kb__kb_search", whitelist)).toBe(true);
    expect(matchesToolWhitelist("mcp__donger-kb__kb_write", whitelist)).toBe(true);
    expect(matchesToolWhitelist("mcp__donger-kb__kb_delete", whitelist)).toBe(true);
  });

  it("MCP 服务器前缀条目：不放行其他服务器与形似名", () => {
    const whitelist = ["mcp__donger-kb", "mcp__donger-git"];
    expect(matchesToolWhitelist("mcp__donger-platform__x", whitelist)).toBe(false);
    expect(matchesToolWhitelist("mcp__donger-gitx__y", whitelist)).toBe(false);
  });

  it("工具级三段名条目不展开为服务器前缀", () => {
    const whitelist = ["mcp__donger-kb__kb_read"];
    expect(matchesToolWhitelist("mcp__donger-kb__kb_read", whitelist)).toBe(true);
    expect(matchesToolWhitelist("mcp__donger-kb__kb_list", whitelist)).toBe(false);
  });
});

describe("runStaticToolGuards 白名单段", () => {
  it("KB 管家白名单（服务器前缀形态）：kb 工具放行、内置工具拒绝", () => {
    const opts = guardOpts(["mcp__donger-kb"]);
    expect(
      runStaticToolGuards({
        toolName: "mcp__donger-kb__kb_read",
        input: { path: "knowledges/faq/x.md" },
        opts,
      }),
    ).toBeNull();
    const bashDenial = runStaticToolGuards({
      toolName: "Bash",
      input: { command: "ls" },
      opts,
    });
    expect(bashDenial?.message).toContain("允许列表");
  });

  it("未配置 allowedTools：不拦（开放 agent 行为不变）", () => {
    expect(
      runStaticToolGuards({
        toolName: "Bash",
        input: { command: "ls" },
        opts: guardOpts(undefined),
      }),
    ).toBeNull();
  });
});
