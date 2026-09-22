import { describe, expect, it } from "vitest";
import {
  CONVERSATION_ALL_LABEL,
  CONVERSATION_MENTION_ALL_ID,
  conversationMarkerLabel,
  fileMarkerLabel,
  type Mention,
  mentionMarker,
  reconcileMentions,
  tokenizeMentionMarkers,
} from "./mentions";

const FILE: Mention = { kind: "file", id: "runtime:src/config.ts", label: "src/config.ts" };
const SKILL: Mention = { kind: "skill", id: "donger:web-ui-iterate", label: "web-ui-iterate" };
const CONN: Mention = { kind: "connector", id: "conn-1", label: "lark" };
const CONV: Mention = { kind: "conversation", id: "conv-1", label: "部署排障" };

describe("fileMarkerLabel", () => {
  it("文件标记取 basename（正反斜杠均兼容）", () => {
    expect(fileMarkerLabel("repos/donger/AGENTS.md")).toBe("AGENTS.md");
    expect(fileMarkerLabel("src\\config.ts")).toBe("config.ts");
    expect(fileMarkerLabel("README.md")).toBe("README.md");
  });

  it("空段兜底返回原值", () => {
    expect(fileMarkerLabel("dir/")).toBe("dir/");
  });
});

describe("mentionMarker", () => {
  it("按类别生成标记", () => {
    expect(mentionMarker(FILE)).toBe("@src/config.ts");
    expect(mentionMarker(SKILL)).toBe("/web-ui-iterate");
    expect(mentionMarker(CONN)).toBe("$lark");
    expect(mentionMarker(CONV)).toBe("%部署排障");
  });
});

describe("conversationMarkerLabel", () => {
  it("去空白与非法字符并截 24 字（与后端同算法）", () => {
    expect(conversationMarkerLabel("部署 排障：v1.0 上线！", "2026-09-20T10:00:00Z")).toBe(
      "部署排障v10上线",
    );
    expect(conversationMarkerLabel("长".repeat(30), "2026-09-20T10:00:00Z")).toHaveLength(24);
  });

  it("全非法字符时回退为日期锚点", () => {
    expect(conversationMarkerLabel("!!!", "2026-09-20T10:00:00Z")).toBe("会话2026-09-20");
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

  it("会话引用按标记对账（全部会话与具体会话）", () => {
    const ALL: Mention = {
      kind: "conversation",
      id: CONVERSATION_MENTION_ALL_ID,
      label: CONVERSATION_ALL_LABEL,
    };
    const text = `对比 %${CONVERSATION_ALL_LABEL} 和 %部署排障`;
    expect(reconcileMentions(text, [ALL, CONV])).toEqual([ALL, CONV]);
    expect(reconcileMentions("只留全部", [ALL, CONV])).toEqual([]);
  });
});

describe("tokenizeMentionMarkers", () => {
  it("识别词首的 @/​/$/% 标记", () => {
    const tokens = tokenizeMentionMarkers(
      "参考 @src/config.ts 和 /web-ui-iterate 与 $lark 还有 %部署排障",
    );
    const mentions = tokens.filter((t) => t.type === "mention");
    expect(mentions.map((t) => t.text)).toEqual([
      "@src/config.ts",
      "/web-ui-iterate",
      "$lark",
      "%部署排障",
    ]);
    expect(mentions.map((t) => t.kind)).toEqual(["file", "skill", "connector", "conversation"]);
  });

  it("不误伤邮箱、金额与完整路径", () => {
    const tokens = tokenizeMentionMarkers("联系 a@b.com 需要 $100，见 /usr/local");
    expect(tokens.filter((t) => t.type === "mention").map((t) => t.text)).toEqual(["/usr"]);
  });

  it("% 后跟数字或非词首不误伤", () => {
    expect(
      tokenizeMentionMarkers("占比%100 和 增长 5%调整").filter((t) => t.type === "mention"),
    ).toEqual([]);
  });

  it("# 识别词首反馈标记；#123 数字体不误伤；词中 # 不误伤", () => {
    const tokens = tokenizeMentionMarkers("处理 #移动端附件无反应 和 #123 与 C#语法");
    const mentions = tokens.filter((t) => t.type === "mention");
    expect(mentions.map((t) => t.text)).toEqual(["#移动端附件无反应"]);
    expect(mentions.map((t) => t.kind)).toEqual(["feedback"]);
  });

  it("纯文本原样切分", () => {
    expect(tokenizeMentionMarkers("你好，世界")).toEqual([{ type: "text", text: "你好，世界" }]);
  });
});
