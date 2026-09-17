import { describe, expect, it } from "vitest";
import { type Mention, mentionMarker, reconcileMentions, tokenizeMentionMarkers } from "./mentions";

const FILE: Mention = { kind: "file", id: "runtime:src/config.ts", label: "src/config.ts" };
const SKILL: Mention = { kind: "skill", id: "donger:web-ui-iterate", label: "web-ui-iterate" };
const CONN: Mention = { kind: "connector", id: "conn-1", label: "lark" };

describe("mentionMarker", () => {
  it("按类别生成标记", () => {
    expect(mentionMarker(FILE)).toBe("@src/config.ts");
    expect(mentionMarker(SKILL)).toBe("/web-ui-iterate");
    expect(mentionMarker(CONN)).toBe("$lark");
  });
});

describe("reconcileMentions", () => {
  it("保留文本中仍有标记的引用", () => {
    const text = "参考 @src/config.ts 用 /web-ui-iterate 改";
    expect(reconcileMentions(text, [FILE, SKILL, CONN])).toEqual([FILE, SKILL]);
  });

  it("标记被删除后不再上送", () => {
    expect(reconcileMentions("不用引用了", [FILE])).toEqual([]);
  });
});

describe("tokenizeMentionMarkers", () => {
  it("识别词首的 @/​/$ 标记", () => {
    const tokens = tokenizeMentionMarkers("参考 @src/config.ts 和 /web-ui-iterate 与 $lark");
    const mentions = tokens.filter((t) => t.type === "mention");
    expect(mentions.map((t) => t.text)).toEqual(["@src/config.ts", "/web-ui-iterate", "$lark"]);
    expect(mentions.map((t) => t.kind)).toEqual(["file", "skill", "connector"]);
  });

  it("不误伤邮箱、金额与完整路径", () => {
    const tokens = tokenizeMentionMarkers("联系 a@b.com 需要 $100，见 /usr/local");
    expect(tokens.filter((t) => t.type === "mention").map((t) => t.text)).toEqual(["/usr"]);
  });

  it("纯文本原样切分", () => {
    expect(tokenizeMentionMarkers("你好，世界")).toEqual([{ type: "text", text: "你好，世界" }]);
  });
});
