import { describe, expect, it } from "vitest";
import type { KbLibrary } from "../../src/domain/kb.js";
import { lineDiff } from "../../src/domain/kb-diff.js";
import {
  canManageKb,
  canReadKb,
  canUseKb,
  kbDeletable,
  kbShareable,
} from "../../src/domain/kb-policy.js";

/** 权限口径单点（spec §7）+ 行级 diff（spec §6.2） */

function lib(partial: Partial<KbLibrary>): KbLibrary {
  return {
    id: "kb1",
    ownerId: "u1",
    name: "n",
    description: "",
    systemPrompt: "",
    builtin: false,
    personal: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...partial,
  };
}

const owner = { id: "u1", role: "user" as const };
const admin = { id: "a1", role: "admin" as const };
const stranger = { id: "u2", role: "user" as const };

describe("kb-policy", () => {
  it("canManageKb：属主/ admin；普通用户不可管理他人库", () => {
    expect(canManageKb(lib({}), owner)).toBe(true);
    expect(canManageKb(lib({}), admin)).toBe(true);
    expect(canManageKb(lib({}), stranger)).toBe(false);
  });

  it("内置库：admin 可管理（D3），全员可读，普通用户不可管理", () => {
    const builtin = lib({ builtin: true, ownerId: "__builtin__" });
    expect(canManageKb(builtin, admin)).toBe(true);
    expect(canManageKb(builtin, stranger)).toBe(false);
    expect(canReadKb(builtin, stranger, false)).toBe(true);
    expect(canUseKb(builtin, stranger, false)).toBe(false);
  });

  it("canUseKb：被授予即可用；canReadKb 个人库仅属主", () => {
    const shared = lib({});
    expect(canUseKb(shared, stranger, true)).toBe(true);
    expect(canReadKb(shared, stranger, true)).toBe(true);
    const personal = lib({ personal: true });
    expect(canReadKb(personal, stranger, false)).toBe(false);
    expect(canReadKb(personal, owner, false)).toBe(true);
  });

  it("personal/builtin 禁分享禁删除（kbShareable/kbDeletable）", () => {
    expect(kbShareable(lib({}))).toBe(true);
    expect(kbShareable(lib({ personal: true }))).toBe(false);
    expect(kbShareable(lib({ builtin: true }))).toBe(false);
    expect(kbDeletable(lib({ personal: true }))).toBe(false);
    expect(kbDeletable(lib({ builtin: true }))).toBe(false);
  });
});

describe("lineDiff", () => {
  it("中段改动产出 -/+ 块，保留前后上下文", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "X", "Y", "f", "g"].join("\n");
    const diff = lineDiff(before, after);
    expect(diff).toContain("-d");
    expect(diff).toContain("-e");
    expect(diff).toContain("+X");
    expect(diff).toContain("+Y");
    expect(diff).toContain(" c"); // 上下文
    expect(diff).not.toContain("-a");
    expect(diff.startsWith("@@")).toBe(true);
  });

  it("空文件/纯新增", () => {
    expect(lineDiff("", "hello\nworld").split("\n")).toHaveLength(3); // @@ 头 + 2 行 +
    expect(lineDiff("hello", "hello")).toBe("");
  });

  it("超长 diff 截断", () => {
    const big = lineDiff("x\n".repeat(50_000), "y\n".repeat(50_000), 1000);
    expect(big.length).toBeLessThan(1100);
    expect(big).toContain("diff 已截断");
  });
});
