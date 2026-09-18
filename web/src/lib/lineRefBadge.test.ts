import { describe, expect, it } from "vitest";
import { lineRefBadge } from "./lineRefBadge";

describe("lineRefBadge", () => {
  it("单个行号引用改为行内代码徽标", () => {
    expect(lineRefBadge("停用后运行时跳过不炸 agent（:31）；")).toBe(
      "停用后运行时跳过不炸 agent（`:31`）；",
    );
  });

  it("范围与多引用整体成为一个徽标", () => {
    expect(lineRefBadge("（:10-17, :24）")).toBe("（`:10-17, :24`）");
    expect(lineRefBadge("加密序列化（:150-156）")).toBe("加密序列化（`:150-156`）");
    expect(lineRefBadge("（:10-17、:24；:31）")).toBe("（`:10-17、:24；:31`）");
  });

  it("围栏代码块内不改写", () => {
    const src = "前文（:8）\n```ts\nfoo（:8）\n```\n后文（:31）";
    expect(lineRefBadge(src)).toBe("前文（`:8`）\n```ts\nfoo（:8）\n```\n后文（`:31`）");
  });

  it("行内代码内不改写", () => {
    expect(lineRefBadge("见 `foo（:8）bar` 与（:31）")).toBe("见 `foo（:8）bar` 与（`:31`）");
  });

  it("非引用与未闭合形态不动", () => {
    const src = "时间（:10:30）与（:8 未闭合及 ASCII (:4) 保持原样";
    expect(lineRefBadge(src)).toBe(src);
    expect(lineRefBadge("字母（:a）不匹配")).toBe("字母（:a）不匹配");
    expect(lineRefBadge("")).toBe("");
  });

  it("无引用文本原样返回", () => {
    const src = "普通中文句子，没有行号引用。";
    expect(lineRefBadge(src)).toBe(src);
  });
});
