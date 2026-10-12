import { describe, expect, it } from "vitest";
import { matchesBashAllowlist } from "../../src/domain/bash-allowlist.js";

describe("bash-allowlist（M2-7 能力集 commands 面）", () => {
  const allow = ["git status", "git log", "npm", "cat"];

  it("白名单内命令放行（含参数）", () => {
    expect(matchesBashAllowlist("git status", allow)).toBe(true);
    expect(matchesBashAllowlist("git status --short", allow)).toBe(true);
    expect(matchesBashAllowlist("npm run build", allow)).toBe(true);
    expect(matchesBashAllowlist("cat ./src/index.ts", allow)).toBe(true);
  });

  it("白名单外命令拒", () => {
    expect(matchesBashAllowlist("whoami", allow)).toBe(false);
    expect(matchesBashAllowlist("git push origin master", allow)).toBe(false); // push 不在条目
    expect(matchesBashAllowlist("curl https://evil.com", allow)).toBe(false);
  });

  it("组合段全命中才放行（一段白名单外即拒）", () => {
    expect(matchesBashAllowlist("git status && git log -1", allow)).toBe(true);
    expect(matchesBashAllowlist("git status && whoami", allow)).toBe(false);
    expect(matchesBashAllowlist("cat a.txt; curl https://x.io", allow)).toBe(false);
  });

  it("空数组=白名单空集=全部拒；边界形态", () => {
    expect(matchesBashAllowlist("git status", [])).toBe(false);
    expect(matchesBashAllowlist("", allow)).toBe(false);
    expect(matchesBashAllowlist("   ", allow)).toBe(false);
    // 前缀边界：条目 "cat" 不命中 "catalog" 命令（须词边界）
    expect(matchesBashAllowlist("catalog", ["cat"])).toBe(false);
  });
});
