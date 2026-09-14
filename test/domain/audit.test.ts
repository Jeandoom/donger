import { describe, expect, it } from "vitest";
import { AUDIT_TRUNCATE_LIMIT, toAuditEvent, userMessageAudit } from "../../src/domain/audit.js";

const ctx = {
  conversationId: "c1",
  userId: "u1",
  taskId: "t1",
  seq: 5,
  recordedAt: "2026-07-01T00:00:00.000Z",
};

describe("toAuditEvent", () => {
  it("text → 完整文本不截断", () => {
    const e = toAuditEvent({ type: "text", taskId: "t1", text: "你好" }, ctx);
    expect(e).toMatchObject({ type: "text", text: "你好", conversationId: "c1", seq: 5 });
  });

  it("tool_use → toolInput 为 JSON 串", () => {
    const e = toAuditEvent(
      { type: "tool_use", taskId: "t1", tool: "Bash", input: { command: "ls" }, toolUseId: "tu1" },
      ctx,
    );
    expect(e).toMatchObject({ type: "tool_use", toolName: "Bash", toolUseId: "tu1" });
    expect(e.toolInput).toBe('{"command":"ls"}');
  });

  it("tool_use.toolInput 超 4096 截断", () => {
    const big = "x".repeat(AUDIT_TRUNCATE_LIMIT + 100);
    const e = toAuditEvent(
      { type: "tool_use", taskId: "t1", tool: "Write", input: { content: big }, toolUseId: "tu" },
      ctx,
    );
    expect(e.toolInput?.length).toBe(AUDIT_TRUNCATE_LIMIT);
  });

  it("tool_result → output 截断 + 挂 durationMs", () => {
    const e = toAuditEvent(
      { type: "tool_result", taskId: "t1", toolUseId: "tu1", content: "ok", isError: false },
      ctx,
      { durationMs: 42 },
    );
    expect(e).toMatchObject({
      type: "tool_result",
      toolOutput: "ok",
      isError: false,
      durationMs: 42,
    });
  });

  it("result → usage + model + durationMs", () => {
    const e = toAuditEvent(
      {
        type: "result",
        taskId: "t1",
        subtype: "success",
        result: "done",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        },
      },
      ctx,
      { durationMs: 1000, model: "glm-5.1" },
    );
    expect(e).toMatchObject({
      type: "result",
      resultSubtype: "success",
      model: "glm-5.1",
      durationMs: 1000,
    });
    expect(e.usage?.inputTokens).toBe(1);
    expect(e.text).toBe("done");
  });

  it("result error → text 取 error", () => {
    const e = toAuditEvent({ type: "result", taskId: "t1", subtype: "error", error: "爆了" }, ctx);
    expect(e.text).toBe("爆了");
    expect(e.resultSubtype).toBe("error");
  });

  it("session_init → 仅上下文", () => {
    const e = toAuditEvent({ type: "session_init", taskId: "t1", sessionId: "s1" }, ctx);
    expect(e).toMatchObject({ type: "session_init", conversationId: "c1" });
  });
});

describe("userMessageAudit", () => {
  it("生成 user_message 事件，prompt 完整不截断", () => {
    const e = userMessageAudit("帮我修 bug", ctx);
    expect(e).toMatchObject({ type: "user_message", text: "帮我修 bug", seq: 5 });
  });
});

describe("redactSecrets（复盘 P2-12：本周真实泄露样本回归）", () => {
  it("URL 内嵌凭证打码（git remote -v / clone 命令）", async () => {
    const { redactSecrets } = await import("../../src/domain/audit.js");
    const out = redactSecrets(
      "git clone https://oauth2:REDACTED-TOKEN@jihulab.com/your-org/your-project.git",
    );
    expect(out).toContain("oauth2:****@");
    expect(out).not.toContain("REDACT");
    expect(out).toContain("jihulab.com/your-org/your-project.git");
  });

  it("query 参数 token 打码（TB MCP URL userToken）", async () => {
    const { redactSecrets } = await import("../../src/domain/audit.js");
    const out = redactSecrets(
      "https://open.teambition.com/api/mcp?userToken=u-ANAxIu37VjMSeVgyRsQM1YXr0o3u8RbFWVLYPy8l3TzjB2Lm",
    );
    expect(out).toContain("userToken=****");
    expect(out).not.toContain("ANAxIu37");
  });

  it("显式标注的 access token / Bearer / PRIVATE-TOKEN 打码", async () => {
    const { redactSecrets } = await import("../../src/domain/audit.js");
    expect(redactSecrets("access token:8f8827b304bfc9273da48f5498f20444")).not.toContain(
      "8f8827b3",
    );
    expect(redactSecrets('curl -H "Authorization: Bearer sk-abc123def"')).not.toContain(
      "abc123def",
    );
    expect(redactSecrets('curl -H "PRIVATE-TOKEN: glpat-xyz"')).not.toContain("glpat-xyz");
  });

  it("Langfuse 风格密钥字面量打码", async () => {
    const { redactSecrets } = await import("../../src/domain/audit.js");
    const out = redactSecrets(
      "PK='pk-lf-9b265621-2238-4078-ba52-c5e14c5e7b0f'; SK='sk-lf-711dc90c'",
    );
    expect(out).not.toContain("9b2656");
    expect(out).not.toContain("711dc9");
    expect(out).toContain("pk-****");
    expect(out).toContain("sk-****");
  });

  it("toAuditEvent 的 toolInput/user_message 走脱敏", async () => {
    const { toAuditEvent, userMessageAudit } = await import("../../src/domain/audit.js");
    const e = toAuditEvent(
      {
        type: "tool_use",
        taskId: "t1",
        tool: "Bash",
        input: { command: "git clone https://oauth2:secret-token-value@x.com/a/b.git" },
        toolUseId: "tu",
      },
      ctx,
    );
    expect(e.toolInput).not.toContain("secret-token-value");
    const m = userMessageAudit("分析下 https://gitee.com/x.git access token:abcd1234efgh5678", ctx);
    expect(m.text).toContain("token:****");
    expect(m.text).not.toContain("abcd1234");
  });
});
