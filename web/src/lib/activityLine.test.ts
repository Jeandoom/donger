import { describe, expect, it } from "vitest";
import { formatActivityLine } from "./activityLine";

describe("formatActivityLine（活动条 v2，chat UE 轮）", () => {
  it("mcp 工具摘要行 → 显示名+参数摘要", () => {
    expect(formatActivityLine('mcp__danger-kb__kb_read {"path":"index.md"}')).toEqual({
      kind: "tool",
      label: "danger-kb · kb_read",
      detail: "index.md",
    });
    expect(
      formatActivityLine('mcp__danger-git__git_pull {"repoName":"stock-analysis","strategy":"ff"}'),
    ).toEqual({
      kind: "tool",
      label: "danger-git · git_pull",
      detail: "stock-analysis",
    });
  });

  it("内置工具行取 command/file_path 等优先键", () => {
    expect(formatActivityLine('Bash {"command":"uv run --with httpx python - <<EOF"}')).toEqual({
      kind: "tool",
      label: "Bash",
      detail: "uv run --with httpx python - <<EOF",
    });
    expect(formatActivityLine('Read {"file_path":"/a/b/c.py","limit":10}')).toEqual({
      kind: "tool",
      label: "Read",
      detail: "/a/b/c.py",
    });
  });

  it("失败行去 ⚠️ 与 mcp 噪音、就地换显示名", () => {
    expect(
      formatActivityLine("⚠️ mcp__danger-kb__kb_read 失败：文件不存在或不可读：index.md"),
    ).toEqual({
      kind: "error",
      label: "danger-kb · kb_read 失败：文件不存在或不可读：index.md",
      detail: "",
    });
    expect(formatActivityLine("Bash 失败，路径不存在")).toMatchObject({
      kind: "error",
      label: "Bash 失败，路径不存在",
    });
  });

  it("阶段横幅/纯文本透传（去 🔧🔨 前缀）；空行安全", () => {
    expect(formatActivityLine("🔨 执行阶段")).toEqual({
      kind: "text",
      label: "执行阶段",
      detail: "",
    });
    expect(formatActivityLine("正在检索知识库…")).toEqual({
      kind: "text",
      label: "正在检索知识库…",
      detail: "",
    });
    expect(formatActivityLine("")).toEqual({ kind: "text", label: "", detail: "" });
  });
});
