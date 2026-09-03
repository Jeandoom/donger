import { describe, expect, it } from "vitest";
import {
  acceptAsk,
  designFirstAsk,
  designRejected,
  executeAfterDesign,
  executeRejected,
  resolvePhases,
} from "../../src/orchestrator/phase-flow.js";

describe("resolvePhases", () => {
  it("requiresDesign=true：design→execute→accept，验收门开", () => {
    const plan = resolvePhases(["x-design", "x-execute", "x-accept"], true);
    expect(plan.steps.map((s) => s.phase)).toEqual(["design", "execute", "accept"]);
    expect(plan.steps[0]?.skills).toEqual(["x-design"]);
    expect(plan.steps[1]?.skills).toEqual(["x-execute"]);
    expect(plan.steps[2]?.skills).toEqual(["x-accept"]);
    expect(plan.acceptanceGate).toBe(true);
  });

  it("requiresDesign=false 但有 accept skill：execute→accept，验收门开", () => {
    const plan = resolvePhases(["x-execute", "x-accept"], false);
    expect(plan.steps.map((s) => s.phase)).toEqual(["execute", "accept"]);
    expect(plan.acceptanceGate).toBe(true);
  });

  it("无 accept skill 且 requiresDesign=false：仅 execute，验收门关（轻量规则）", () => {
    const plan = resolvePhases(["x-execute"], false);
    expect(plan.steps.map((s) => s.phase)).toEqual(["execute"]);
    expect(plan.acceptanceGate).toBe(false);
  });

  it("requiresDesign=true 但无 design skill：design 阶段仍在（空 skills，靠系统提示出方案）", () => {
    const plan = resolvePhases(["x-execute", "x-accept"], true);
    expect(plan.steps.map((s) => s.phase)).toEqual(["design", "execute", "accept"]);
    expect(plan.steps[0]?.skills).toEqual([]);
  });

  it("execute 无后缀匹配：回退全量 skills（兼容存量 agent）", () => {
    const plan = resolvePhases(["s:1", "s:2"], false);
    expect(plan.steps[0]?.skills).toEqual(["s:1", "s:2"]);
    expect(plan.acceptanceGate).toBe(false);
  });
});

describe("阶段 prompt", () => {
  it("各构造器输出含关键词", () => {
    expect(designFirstAsk("加个导出接口")).toContain("加个导出接口");
    expect(designFirstAsk("加个导出接口")).toContain("实施方案");
    expect(designRejected("范围太大")).toContain("方案被驳回");
    expect(designRejected("范围太大")).toContain("范围太大");
    expect(executeAfterDesign()).toContain("方案已确认");
    expect(executeRejected("少了一个用例")).toContain("验收被驳回");
    expect(acceptAsk()).toContain("自验");
  });
});
