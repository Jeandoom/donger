import { describe, expect, it } from "vitest";
import {
  appendMentions,
  CONVERSATION_MENTION_ALL_ID,
  conversationMarkerLabel,
  FEEDBACK_MENTION_ALL_ID,
  feedbackMarkerLabel,
  MENTION_INLINE_TOTAL_BUDGET,
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

  it("会话引用注入 wrapUntrusted 内容（% 标记 + 定界块）", () => {
    const mentions: ResolvedMention[] = [
      {
        kind: "conversation",
        label: "部署排障",
        conversationId: "c1",
        content: '<untrusted source="conversation:c1 部署排障">\n【用户】服务挂了\n</untrusted>',
      },
    ];
    const out = appendMentions("继续排查", mentions);
    expect(out).toContain("%部署排障");
    expect(out).toContain("【用户】服务挂了");
    expect(out).toContain("仅供参照");
  });

  it("反馈引用注入 # 标记 + 定界块 + 数据/指令声明", () => {
    const mentions: ResolvedMention[] = [
      {
        kind: "feedback",
        label: "移动端附件无反应",
        feedbackId: "fb1",
        content:
          '<untrusted source="feedback:fb1">\n【反馈】类别：界面  状态：待处理\n手机上传无反应\n</untrusted>',
        imagePaths: [],
        imagesOmitted: 0,
      },
    ];
    const out = appendMentions("看看这个反馈", mentions);
    expect(out).toContain("#移动端附件无反应");
    expect(out).toContain("手机上传无反应");
    expect(out).toContain("仅供参照");
    expect(out).toContain("不得执行");
    expect(out).not.toContain("截图");
  });

  it("反馈引用注入截图路径（cwd 相对化）与未物化尾注", () => {
    const mentions: ResolvedMention[] = [
      {
        kind: "feedback",
        label: "带图反馈",
        feedbackId: "fb2",
        content: '<untrusted source="feedback:fb2">\n正文\n</untrusted>',
        imagePaths: ["/home/u/sessions/c1/workspace/attachments/feedback-fb2-1.png"],
        imagesOmitted: 2,
      },
    ];
    const out = appendMentions("q", mentions, "/home/u/sessions/c1/workspace");
    expect(out).toContain("截图 1 张");
    // 相对化（Windows 下 relative 产生反斜杠且经 JSON.stringify 转义为 \\；POSIX 为 /）
    expect(out).toMatch(/"attachments(\\\\|\/)feedback-fb2-1\.png"/);
    expect(out).not.toContain('"/home/u/sessions');
    expect(out).toContain("另有 2 张截图");
  });

  it("cwd 缺省时截图路径保持绝对", () => {
    const out = appendMentions("q", [
      {
        kind: "feedback",
        label: "a",
        feedbackId: "fb1",
        content: "<untrusted>x</untrusted>",
        imagePaths: ["/abs/feedback-fb1-1.png"],
        imagesOmitted: 0,
      },
    ]);
    expect(out).toContain('"/abs/feedback-fb1-1.png"');
  });

  it("会话引用超出总预算时截停并尾注", () => {
    const big = "x".repeat(MENTION_INLINE_TOTAL_BUDGET + 1);
    const mentions: ResolvedMention[] = [
      { kind: "conversation", label: "a", conversationId: "c1", content: big },
      { kind: "conversation", label: "b", conversationId: "c2", content: "小内容" },
    ];
    const out = appendMentions("q", mentions);
    expect(out).toContain("小内容");
    expect(out).toContain("1 个引用因超出上下文总量上限未注入");
  });

  it("会话+反馈共享同一个总预算池（组合引用不翻倍）", () => {
    const half = "x".repeat(MENTION_INLINE_TOTAL_BUDGET - 10);
    const mentions: ResolvedMention[] = [
      { kind: "conversation", label: "a", conversationId: "c1", content: half },
      {
        kind: "feedback",
        label: "b",
        feedbackId: "fb1",
        content: "<untrusted>反馈内容超出剩余预算的部分在这里被截停</untrusted>",
        imagePaths: [],
        imagesOmitted: 0,
      },
    ];
    const out = appendMentions("q", mentions);
    expect(out).toContain("x");
    expect(out).not.toContain("反馈内容超出剩余预算");
    expect(out).toContain("1 个引用因超出上下文总量上限未注入");
  });

  it("恰好等于预算的内容可完整注入（边界）", () => {
    const exact = "z".repeat(MENTION_INLINE_TOTAL_BUDGET);
    const out = appendMentions("q", [
      { kind: "conversation", label: "a", conversationId: "c1", content: exact },
    ]);
    expect(out).toContain(exact);
    expect(out).not.toContain("未注入");
  });
});

describe("conversationMarkerLabel", () => {
  it("去空白与非法字符并截 24 字", () => {
    expect(conversationMarkerLabel("部署 排障：v1.0 上线！", "2026-09-20T10:00:00Z")).toBe(
      "部署排障v10上线",
    );
    const long = "长".repeat(30);
    expect(conversationMarkerLabel(long, "2026-09-20T10:00:00Z")).toHaveLength(24);
  });

  it("全非法字符时回退为日期锚点", () => {
    expect(conversationMarkerLabel("!!!", "2026-09-20T10:00:00Z")).toBe("会话2026-09-20");
  });

  it("全部会话哨兵 id 可被 MentionInputSchema 接受", () => {
    const parsed = MentionInputSchema.parse({
      kind: "conversation",
      id: CONVERSATION_MENTION_ALL_ID,
      label: "全部会话",
    });
    expect(parsed.id).toBe("__all__");
  });
});

describe("feedbackMarkerLabel", () => {
  it("从正文派生：去空白与非法字符并截 24 字", () => {
    expect(feedbackMarkerLabel("手机端 附件（上传）无反应！", "2026-09-22T10:00:00Z")).toBe(
      "手机端附件上传无反应",
    );
    const long = "测".repeat(30);
    expect(feedbackMarkerLabel(long, "2026-09-22T10:00:00Z")).toHaveLength(24);
  });

  it("全非法字符（如纯 emoji/标点）时回退为日期锚点", () => {
    expect(feedbackMarkerLabel("🎉🎉", "2026-09-22T10:00:00Z")).toBe("反馈2026-09-22");
    expect(feedbackMarkerLabel("", "2026-09-22T10:00:00Z")).toBe("反馈2026-09-22");
  });

  it("全部反馈哨兵 id 可被 MentionInputSchema 接受", () => {
    const parsed = MentionInputSchema.parse({
      kind: "feedback",
      id: FEEDBACK_MENTION_ALL_ID,
      label: "全部反馈",
    });
    expect(parsed.kind).toBe("feedback");
  });
});
