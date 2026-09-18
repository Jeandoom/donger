import { describe, expect, it } from "vitest";
import {
  appendMentions,
  MentionInputSchema,
  type ResolvedMention,
} from "../../src/domain/mentions.js";

describe("MentionInputSchema", () => {
  it("接受合法引用", () => {
    const parsed = MentionInputSchema.parse({
      kind: "file",
      id: "runtime:a/b.md",
      label: "a/b.md",
    });
    expect(parsed.kind).toBe("file");
  });

  it("拒绝未知 kind 与空 id", () => {
    expect(MentionInputSchema.safeParse({ kind: "repo", id: "x", label: "x" }).success).toBe(false);
    expect(MentionInputSchema.safeParse({ kind: "file", id: "", label: "x" }).success).toBe(false);
  });
});

describe("appendMentions", () => {
  it("无引用时原样返回", () => {
    expect(appendMentions("hello")).toBe("hello");
    expect(appendMentions("hello", [])).toBe("hello");
  });

  it("按类别注入路径/技能/连接器提示行", () => {
    const mentions: ResolvedMention[] = [
      { kind: "file", label: "src/config.ts", path: "/home/u/agents/a1/workspace/src/config.ts" },
      { kind: "skill", label: "web-ui-iterate", name: "donger:web-ui-iterate" },
      { kind: "connector", label: "lark", name: "lark" },
    ];
    const out = appendMentions("帮我改配置", mentions);
    expect(out.startsWith("帮我改配置\n\n## 用户引用\n")).toBe(true);
    expect(out).toContain("@src/config.ts");
    expect(out).toContain('"/home/u/agents/a1/workspace/src/config.ts"');
    expect(out).toContain("/web-ui-iterate");
    expect(out).toContain("$lark");
    expect(out).toContain("Read");
  });

  it("不内联文件内容（只注路径）", () => {
    const out = appendMentions("q", [{ kind: "file", label: "a.md", path: "/x/a.md" }]);
    expect(out).not.toContain("# a.md 的内容");
  });
});
