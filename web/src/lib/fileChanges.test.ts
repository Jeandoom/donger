import { describe, expect, it } from "vitest";
import { extractChangedFilePaths, shortChangePath, toolChangePath } from "./fileChanges";

describe("toolChangePath", () => {
  it("解析 Write/Edit/MultiEdit 的 file_path", () => {
    expect(toolChangePath("Write", '{"file_path":"/w/a.md","content":"hi"}')).toBe("/w/a.md");
    expect(
      toolChangePath("Edit", '{"file_path":"/w/b.ts","old_string":"a","new_string":"b"}'),
    ).toBe("/w/b.ts");
    expect(
      toolChangePath(
        "MultiEdit",
        '{"file_path":"/w/c.py","edits":[{"old_string":"","new_string":""}]}',
      ),
    ).toBe("/w/c.py");
  });

  it("解析 NotebookEdit 的 notebook_path", () => {
    expect(toolChangePath("NotebookEdit", '{"notebook_path":"/w/n.ipynb"}')).toBe("/w/n.ipynb");
  });

  it("入参被截断时按前缀字段抢救 file_path", () => {
    const clipped = '{"file_path":"/w/report.docx","content":"第一段文字…（后续被截断';
    expect(() => JSON.parse(clipped)).toThrow();
    expect(toolChangePath("Write", clipped)).toBe("/w/report.docx");
  });

  it("非写入类工具与空入参返回 null", () => {
    expect(toolChangePath("Bash", '{"command":"ls"}')).toBeNull();
    expect(toolChangePath("Write", "")).toBeNull();
    expect(toolChangePath("Write", '{"file_path":""}')).toBeNull();
  });
});

describe("extractChangedFilePaths", () => {
  it("过滤非文件工具并按出现顺序去重", () => {
    expect(
      extractChangedFilePaths([
        { tool: "Read", inputPreview: '{"file_path":"/w/a.md"}' },
        { tool: "Write", inputPreview: '{"file_path":"/w/a.md","content":"x"}' },
        { tool: "Edit", inputPreview: '{"file_path":"/w/b.ts","old_string":"","new_string":""}' },
        { tool: "Write", inputPreview: '{"file_path":"/w/a.md","content":"y"}' },
        { tool: "Bash", inputPreview: '{"command":"pwd"}' },
      ]),
    ).toEqual(["/w/a.md", "/w/b.ts"]);
  });
});

describe("shortChangePath", () => {
  it("workspace 内路径取相对段（保留层级）", () => {
    expect(shortChangePath("/home/u/sessions/c1/workspace/src/lib/a b.ts")).toBe("src/lib/a b.ts");
  });

  it("Windows 反斜杠先归一，非 workspace 路径取文件名", () => {
    expect(shortChangePath("C:\\out\\报告.docx")).toBe("报告.docx");
  });
});
