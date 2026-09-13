import { describe, expect, it } from "vitest";
import { collapseToolNarration } from "./toolNarration";

describe("collapseToolNarration", () => {
  it("普通文本原样返回", () => {
    const text = "1+1 等于 2。";
    expect(collapseToolNarration(text)).toBe(text);
  });

  it("短工具输出不折叠", () => {
    const text = '**Output:**\n**summary:** [{"text": "ok"}]';
    expect(collapseToolNarration(text)).toBe(text);
  });

  it("超长 Output 载荷折叠为代码块", () => {
    const payload = JSON.stringify({ text: "x".repeat(500) });
    const text = `**Output:**\n**analyze_image_result_summary:** ${payload}`;
    const out = collapseToolNarration(text);
    expect(out).toContain("工具输出");
    expect(out).toContain("```");
    expect(out).toContain(`原始内容 ${payload.length} 字符`); // 长度标注
    expect(out).toContain(payload.trimEnd()); // 原文保留
    // 折叠后载荷不再以裸段落形式出现
    expect(out.indexOf("```")).toBeLessThan(out.indexOf(payload));
  });

  it("保留 Output 之前的正文", () => {
    const payload = "y".repeat(400);
    const text = `前置结论：图片正常。\n**Output:**\n**summary:** ${payload}`;
    const out = collapseToolNarration(text);
    expect(out.startsWith("前置结论：图片正常。")).toBe(true);
    expect(out).toContain("```");
  });
});
