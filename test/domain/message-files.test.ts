import { describe, expect, it } from "vitest";
import { appendMessageFiles } from "../../src/domain/message-files.js";

describe("appendMessageFiles", () => {
  it("要求 Agent 先读取附件并保留原始问题", () => {
    const prompt = appendMessageFiles("总结文件", [
      { path: "D:/data/sessions/c1/readme.md", name: "readme.md", type: "markdown" },
    ]);

    expect(prompt).toContain("总结文件");
    expect(prompt).toContain("请先使用 Read 工具读取");
    expect(prompt).toContain("D:/data/sessions/c1/readme.md");
  });

  it("没有附件时不修改 prompt", () => {
    expect(appendMessageFiles("hi")).toBe("hi");
  });
});
