import { describe, expect, it } from "vitest";
import { parseFileArgs } from "../src/chat.js";
import { renderMarkdown } from "../src/render.js";

describe("parseFileArgs", () => {
  it("仅路径", () => {
    expect(parseFileArgs("D:\\a\\x.jpg")).toEqual({ path: "D:\\a\\x.jpg", question: "" });
  });

  it("路径 + 提问一行直达", () => {
    expect(parseFileArgs("D:\\a\\x.jpg 这图里是什么")).toEqual({
      path: "D:\\a\\x.jpg",
      question: "这图里是什么",
    });
  });

  it("路径含空格且无提问：整段视为路径", () => {
    expect(parseFileArgs("D:\\My Files\\a b.png")).toEqual({
      path: "D:\\My Files\\a b.png",
      question: "",
    });
  });

  it("非附件扩展名的首 token 不切分", () => {
    expect(parseFileArgs("D:\\a.b\\x.zzz 看看")).toEqual({
      path: "D:\\a.b\\x.zzz 看看",
      question: "",
    });
  });

  it("任意类型放开：常见文档扩展名的首 token 也切分", () => {
    expect(parseFileArgs("D:\\报表2026.xlsx 总结一下")).toEqual({
      path: "D:\\报表2026.xlsx",
      question: "总结一下",
    });
  });

  it("去掉首尾引号", () => {
    expect(parseFileArgs('"D:\\My Files\\a.jpg"')).toEqual({
      path: "D:\\My Files\\a.jpg",
      question: "",
    });
  });
});

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

  it("表格渲染为对齐表格；列表保持原样", () => {
    const r = renderMarkdown("| 模块 | 状态 |\n|---|---|\n| runner | ✅ |\n- 项目", true);
    expect(r).toContain("模块"); // 表头进 cli-table3
    expect(r).toContain("runner");
    expect(r).toContain("├"); // 表格有分隔框线
    expect(r).toContain("- 项目");
    // 非 TTY 表格原样
    const src = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(renderMarkdown(src, false)).toBe(src);
  });
});
