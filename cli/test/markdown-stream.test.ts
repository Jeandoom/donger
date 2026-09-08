import { describe, expect, it } from "vitest";
import { MarkdownStream } from "../src/markdown-stream.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

/** 按字符块灌入（模拟 delta 分片） */
function feedAll(stream: MarkdownStream, src: string, chunk = 3): string {
  let out = "";
  for (let i = 0; i < src.length; i += chunk) {
    out += stream.feed(src.slice(i, i + chunk));
  }
  return out + stream.end();
}

describe("MarkdownStream", () => {
  it("非 TTY（color=false）完全直通", () => {
    const s = new MarkdownStream(false);
    const src = "# 标题\n```js\nconst a=1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(feedAll(s, src)).toBe(src);
  });

  it("普通文本行照旧直出（保实时）", () => {
    const s = new MarkdownStream(true);
    expect(strip(feedAll(s, "第一行\n第二行"))).toBe("第一行\n第二行");
  });

  it("代码块缓冲到闭合后盒装成型", () => {
    const s = new MarkdownStream(true);
    const out = strip(feedAll(s, "前文\n```js\nconst a = 1;\nconst b = 2;\n```\n后文"));
    expect(out).toContain("前文");
    expect(out).toContain("┌");
    expect(out).toContain("│ const a = 1;");
    expect(out).toContain("└");
    expect(out).toContain("后文");
    expect(out).not.toContain("```"); // 围栏被盒装替代
  });

  it("未闭合代码块在 end() 时兜底盒装", () => {
    const s = new MarkdownStream(true);
    let out = s.feed("```js\nconst a = 1;\n");
    expect(out).toBe(""); // 缓冲中，不输出
    out += s.end();
    expect(strip(out)).toContain("│ const a = 1;");
    expect(strip(out)).toContain("└");
  });

  it("表格：表头+分隔行后进入缓冲，空行收束渲染", () => {
    const s = new MarkdownStream(true);
    const out = strip(
      feedAll(s, "结果如下：\n| 模块 | 状态 |\n|---|---|\n| runner | ✅ |\n\n后续说明"),
    );
    expect(out).toContain("结果如下：");
    expect(out).toContain("├"); // cli-table3 分隔框线
    expect(out).toContain("runner");
    expect(out).toContain("后续说明");
  });

  it("孤立 | 行（非表格）原样输出", () => {
    const s = new MarkdownStream(true);
    const out = strip(feedAll(s, "| 只有一行 |\n普通行"));
    expect(out).toContain("| 只有一行 |");
    expect(out).toContain("普通行");
    expect(out).not.toContain("├");
  });

  it("delta 任意分片下输出与整段一致（普通文本）", () => {
    const src = "alpha beta\ngamma delta epsilon\nzeta";
    expect(feedAll(new MarkdownStream(true), src, 1)).toBe(
      feedAll(new MarkdownStream(true), src, 7),
    );
  });
});
