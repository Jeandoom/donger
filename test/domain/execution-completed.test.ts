import { describe, expect, it } from "vitest";
import { parseEventInput } from "../../src/domain/event.js";
import {
  type ExecutionCompletedFact,
  buildExecutionCompletedPayload,
  buildExecutionFilesManifest,
  executionStatusWord,
  formatExecutionDuration,
  matchExecutionCompletedSubscription,
  parseExecutionCompletedPayload,
  truncateExecutionResultText,
} from "../../src/domain/event-payloads.js";

const fact: ExecutionCompletedFact = {
  schemaVersion: 1,
  event: "agent.execution.completed",
  runId: "r1",
  agentId: "a1",
  agentName: "A01",
  workflowId: "wf1",
  workflowName: "W",
  ownerId: "u1",
  status: "success",
  startedAt: "2026-10-19T00:00:00Z",
  endedAt: "2026-10-19T00:03:04Z",
  durationMs: 184_000,
  error: null,
  trigger: { source: "event", eventId: "e1", causedByRunId: "r0", cascadeDepth: 1 },
  result: { text: "结论", files: [] },
};

describe("execution completed payload 契约", () => {
  it("build/parse 往返；形状不符/非 JSON → null", () => {
    const payload = buildExecutionCompletedPayload(fact);
    expect(parseExecutionCompletedPayload(payload)).toEqual(fact);
    expect(parseExecutionCompletedPayload("not json")).toBeNull();
    expect(parseExecutionCompletedPayload(JSON.stringify({ hello: 1 }))).toBeNull();
    expect(parseExecutionCompletedPayload(JSON.stringify({ ...fact, schemaVersion: 2 }))).toBeNull();
    expect(parseExecutionCompletedPayload(JSON.stringify({ ...fact, runId: "" }))).toBeNull();
    expect(
      parseExecutionCompletedPayload(
        JSON.stringify({ ...fact, result: { text: 1, files: [] } }),
      ),
    ).toBeNull();
  });

  it("订阅判定：属主硬守卫 + 主体命中 + 时机过滤", () => {
    const sub = { ownerId: "u1", name: "agent.execution.completed", subjects: ["a1"] };
    expect(matchExecutionCompletedSubscription(sub, fact)).toBe(true);
    // 属主不同（D4 硬守卫）：即使智能体命中也不投递
    expect(matchExecutionCompletedSubscription({ ...sub, ownerId: "u2" }, fact)).toBe(false);
    // 主体不命中
    expect(matchExecutionCompletedSubscription({ ...sub, subjects: ["a2"] }, fact)).toBe(false);
    // 时机：failed 事实对 timing=success 不命中；all 恒命中；缺省 all
    const failedFact = { ...fact, status: "failed" as const };
    expect(matchExecutionCompletedSubscription({ ...sub, timing: "success" }, failedFact)).toBe(
      false,
    );
    expect(matchExecutionCompletedSubscription({ ...sub, timing: "failed" }, failedFact)).toBe(true);
    expect(matchExecutionCompletedSubscription({ ...sub, timing: "all" }, failedFact)).toBe(true);
    expect(matchExecutionCompletedSubscription({ ...sub, timing: undefined }, failedFact)).toBe(
      true,
    );
    // 工作流视角：主体取 workflowId
    expect(
      matchExecutionCompletedSubscription(
        { ownerId: "u1", name: "workflow.execution.completed", subjects: ["wf1"] },
        fact,
      ),
    ).toBe(true);
  });

  it("文本截断与简报辅助", () => {
    expect(truncateExecutionResultText("短文本")).toBe("短文本");
    const long = "x".repeat(2001);
    const truncated = truncateExecutionResultText(long);
    expect(truncated.length).toBeLessThanOrEqual(2000 + 6);
    expect(truncated.endsWith("[已截断]")).toBe(true);
    expect(executionStatusWord("success")).toBe("成功完成");
    expect(formatExecutionDuration(184_000)).toBe("3 分 4 秒");
    expect(formatExecutionDuration(30_000)).toBe("30 秒");
    expect(buildExecutionFilesManifest([])).toBe("");
  });
});

describe("EventSystemConfig schema refine（完成事件 subjects/timing）", () => {
  const base = { ownerId: "u1", name: "E", type: "system" };

  it("完成事件必须带 subjects；无主体 400 语义", () => {
    expect(() =>
      parseEventInput({
        ...base,
        system: { name: "agent.execution.completed", subjects: ["a1"] },
      }),
    ).not.toThrow();
    expect(() =>
      parseEventInput({ ...base, system: { name: "agent.execution.completed" } }),
    ).toThrow(/主体/);
  });

  it("完成事件不接受非 always matcher；feedback.created 不接受 subjects/timing", () => {
    expect(() =>
      parseEventInput({
        ...base,
        system: {
          name: "agent.execution.completed",
          subjects: ["a1"],
          matcher: { kind: "bodyContains", keyword: "x" },
        },
      }),
    ).toThrow(/匹配条件/);
    expect(() =>
      parseEventInput({
        ...base,
        system: { name: "feedback.created", subjects: ["a1"] },
      }),
    ).toThrow(/主体/);
    // 存量形态不变：feedback.created + matcher 照常
    expect(() =>
      parseEventInput({
        ...base,
        system: { name: "feedback.created", matcher: { kind: "always" } },
      }),
    ).not.toThrow();
  });
});

// ===== correlation 白名单透传（2026-10-20 反馈闭环 M1）=====
import { buildFeedbackCreatedPayload, extractExecutionCorrelation } from "../../src/domain/event-payloads.js";

describe("execution correlation 提取与透传", () => {
  const fbPayload = buildFeedbackCreatedPayload({
    id: "fb-9",
    category: "ui",
    status: "open",
    content: "按钮失灵",
    submitterId: "u-9",
    submitterName: "提交人甲",
    imageCount: 0,
    createdAt: "2026-10-20T00:00:00Z",
  });

  it("extractExecutionCorrelation：feedback.created → 因果键；其余 → null", () => {
    expect(extractExecutionCorrelation(fbPayload)).toEqual({
      feedbackId: "fb-9",
      submitterId: "u-9",
    });
    expect(extractExecutionCorrelation('{"event":"loop.tick"}')).toBeNull();
    expect(extractExecutionCorrelation('{"event":"feedback.created","feedback":{}}')).toBeNull();
    expect(extractExecutionCorrelation("not json")).toBeNull();
  });

  it("信封带 correlation 往返；坏 correlation 剥除", () => {
    const withCorr = { ...fact, correlation: { feedbackId: "fb-9", submitterId: "u-9" } };
    const payload = buildExecutionCompletedPayload(withCorr);
    expect(parseExecutionCompletedPayload(payload)).toEqual(withCorr);

    const badCorr = JSON.stringify({
      ...fact,
      correlation: { feedbackId: 42 },
    });
    expect(parseExecutionCompletedPayload(badCorr)?.correlation).toBeUndefined();
  });
});
