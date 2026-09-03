import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/render.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

describe("renderMarkdown", () => {
  it("非 TTY（color=false）原文直通", () => {
    const src = "# 标题\n**粗体**\n```\ncode\n```";
    expect(renderMarkdown(src, false)).toBe(src);
  });

  it("代码块盒装（含宽度撑齐与未闭合兜底）", () => {
    const closed = strip(renderMarkdown("前\n```js\nconst a = 1;\n```\n后", true));
    expect(closed).toContain("┌");
    expect(closed).toContain("│ const a = 1;");
    expect(closed).toContain("└");
    const unclosed = strip(renderMarkdown("```\nabc", true));
    expect(unclosed).toContain("│ abc");
  });

  it("标题去 # 加粗下划线；粗体替换；引用缩进", () => {
    const r = renderMarkdown("# 标题\n这是**重点**\n> 引用句", true);
    expect(r).not.toContain("# 标题");
    expect(r).toContain("标题");
    expect(r).not.toContain("**");
    expect(r).toContain("重点");
    expect(r).toContain("▌ 引用句");
  });

  it("表格与列表保持原样", () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n- 项目";
    expect(renderMarkdown(src, true)).toBe(src);
  });
});
