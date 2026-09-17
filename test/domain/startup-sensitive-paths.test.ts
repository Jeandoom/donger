import { describe, expect, it } from "vitest";
import { isStartupSensitivePath } from "../../src/domain/startup-sensitive-paths.js";

describe("isStartupSensitivePath（写入硬 deny 清单，规格 §5.3）", () => {
  it(".claude 目录内任意文件均拒绝（Windows/POSIX 分隔符）", () => {
    expect(isStartupSensitivePath("C:\\ws\\sessions\\c1\\.claude\\settings.json")).toBe(true);
    expect(isStartupSensitivePath("C:\\ws\\.claude\\settings.local.json")).toBe(true);
    expect(isStartupSensitivePath("/home/u/sessions/c1/.claude/commands/deploy.md")).toBe(true);
  });

  it("项目级 MCP / 全局配置文件拒绝", () => {
    expect(isStartupSensitivePath("C:\\ws\\sessions\\c1\\.mcp.json")).toBe(true);
    expect(isStartupSensitivePath("C:\\ws\\.claude.json")).toBe(true);
  });

  it("普通业务文件放行", () => {
    expect(isStartupSensitivePath("C:\\ws\\sessions\\c1\\src\\app.ts")).toBe(false);
    expect(isStartupSensitivePath("C:\\ws\\CLAUDE.md")).toBe(false);
    expect(isStartupSensitivePath("C:\\ws\\docs\\claude-notes\\a.md")).toBe(false);
    expect(isStartupSensitivePath("C:\\ws\\settings.json")).toBe(false);
  });
});
