import { describe, expect, it } from "vitest";
import {
  AgentExtensionDirectoriesInputSchema,
  AgentExtensionDirectoriesSchema,
  isRelativeExtensionPath,
} from "../../src/domain/extension-directory.js";

describe("AgentExtensionDirectoriesSchema（存储形态，读容忍）", () => {
  it("存量绝对路径条目仍可解析（unmarshal 不毒化）", () => {
    expect(
      AgentExtensionDirectoriesSchema.parse([
        { id: "d1", name: "docs", path: "D:\\legacy\\dir", access: "readOnly" },
        { id: "d2", name: "nix", path: "/var/data", access: "readWrite" },
      ]),
    ).toHaveLength(2);
  });

  it("拒绝重复 id / 显示名", () => {
    expect(() =>
      AgentExtensionDirectoriesSchema.parse([
        { id: "d1", name: "docs", path: "docs", access: "readOnly" },
        { id: "d1", name: "docs", path: "other", access: "readWrite" },
      ]),
    ).toThrow();
  });
});

describe("AgentExtensionDirectoriesInputSchema（写入形态，写严格）", () => {
  it("接受合法相对路径并归一 \\ 为 /", () => {
    const parsed = AgentExtensionDirectoriesInputSchema.parse([
      { id: "d1", name: "docs", path: "knowledge_base\\specs", access: "readOnly" },
    ]);
    expect(parsed[0]?.path).toBe("knowledge_base/specs");
  });

  it.each([
    ["POSIX 根", "/etc/data"],
    ["Windows 盘符正斜杠", "D:/code/donger"],
    ["Windows 盘符反斜杠", "D:\\code\\donger"],
    ["UNC", "\\\\host\\share"],
    ["协议相对", "//host/share"],
    [".. 上跳", "docs/../secret"],
    [".. 前缀", "../outside"],
    ["空串", ""],
  ])("拒绝%s：%j", (_label, path) => {
    expect(() =>
      AgentExtensionDirectoriesInputSchema.parse([
        { id: "d1", name: "docs", path, access: "readOnly" },
      ]),
    ).toThrow();
  });

  it("名称含 .. 的子目录段合法（docs..dir 不是上跳）", () => {
    expect(() =>
      AgentExtensionDirectoriesInputSchema.parse([
        { id: "d1", name: "docs", path: "docs..dir/sub", access: "readOnly" },
      ]),
    ).not.toThrow();
  });
});

describe("isRelativeExtensionPath", () => {
  it.each([
    ["knowledge_base/docs", true],
    ["agents/a1/workspace", true],
    ["a\\b", true],
    ["/abs", false],
    ["C:\\x", false],
    ["C:/x", false],
    ["\\\\srv\\s", false],
    ["//srv/s", false],
    ["../up", false],
    ["a/../b", false],
    ["", false],
  ])("%j → %j", (input, expected) => {
    expect(isRelativeExtensionPath(input)).toBe(expected);
  });
});
