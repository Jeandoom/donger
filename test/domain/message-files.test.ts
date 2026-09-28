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

  it("传入 cwd 时附件路径相对化且转正斜杠（零转义，防模型照抄错层）", () => {
    const prompt = appendMessageFiles(
      "分析账单",
      [
        {
          path: "D:\\code\\donger\\.deploy\\donger\\data\\workspace\\users\\u1\\sessions\\c1\\workspace\\attachments\\账单.xlsx",
          name: "账单.xlsx",
          type: "document",
        },
      ],
      "D:\\code\\donger\\.deploy\\donger\\data\\workspace\\users\\u1\\sessions\\c1\\workspace",
    );
    expect(prompt).toContain("attachments/账单.xlsx");
    expect(prompt).not.toContain(".deploy");
    expect(prompt).not.toContain("\\\\");
    expect(prompt).toContain("路径均相对当前工作目录");
    expect(prompt).toContain("原样照抄");
  });

  it("cwd 提供但路径跨盘/无法相对化时回退绝对路径", () => {
    const prompt = appendMessageFiles(
      "看下",
      [{ path: "E:\\other\\file.csv", name: "file.csv", type: "document" }],
      "C:\\somewhere\\workspace",
    );
    expect(prompt).toContain("E:\\\\other\\\\file.csv");
  });
});
