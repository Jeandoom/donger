import { describe, expect, it } from "vitest";
import {
  acceptAsk,
  designFirstAsk,
  designRejected,
  executeAfterDesign,
  executeRejected,
  MAX_ACCEPTANCE_REJECTIONS,
  MAX_DESIGN_REJECTIONS,
} from "../../src/orchestrator/phase-flow.js";

describe("门编排常量", () => {
  it("驳回熔断上限为正数", () => {
    expect(MAX_DESIGN_REJECTIONS).toBeGreaterThan(0);
    expect(MAX_ACCEPTANCE_REJECTIONS).toBeGreaterThan(0);
  });
});

describe("门 prompt 构造器", () => {
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
