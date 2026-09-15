import { describe, expect, it } from "vitest";
import { isChatTaskType, parseRoutingDecision } from "../../src/domain/routing.js";

const VALID = {
  agentId: "agent-ops",
  taskType: "ops-inspect",
  rationale: "SLS 巡检类任务，路由到运维 agent",
};

describe("parseRoutingDecision", () => {
  it("解析裸 JSON", () => {
    expect(parseRoutingDecision(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("解析 ```json 代码块包裹的 JSON", () => {
    const text = `已分析任务，结论如下：\n\`\`\`json\n${JSON.stringify(VALID, null, 2)}\n\`\`\``;
    expect(parseRoutingDecision(text)).toEqual(VALID);
  });

  it("容忍 JSON 前后的解释性文字", () => {
    const text = `根据登记表，选择如下：\n${JSON.stringify(VALID)}\n以上。`;
    expect(parseRoutingDecision(text)).toEqual(VALID);
  });

  it("字段缺失时抛错", () => {
    expect(() => parseRoutingDecision('{"agentId":"x"}')).toThrow(/路由决策/);
  });

  it("无 JSON 时抛错", () => {
    expect(() => parseRoutingDecision("无法路由，登记表为空")).toThrow(/路由决策/);
  });

  it("JSON 字符串值内裸换行自动修复", () => {
    const raw = '{"agentId":"a1","taskType":"chat",\n  "rationale":"第一行\n第二行"}';
    const r = parseRoutingDecision(raw);
    expect(r.agentId).toBe("a1");
    expect(r.rationale).toBe("第一行\n第二行");
  });

  it("未知字段（如旧版 requiresDesign）被剥离不报错", () => {
    const raw =
      '结论如下：\n```json\n{"agentId":"a1","requiresDesign":true,"taskType":"dev","rationale":"匹配"}\n```\n以上。';
    expect(parseRoutingDecision(raw)).toEqual({
      agentId: "a1",
      taskType: "dev",
      rationale: "匹配",
    });
  });
});

describe("isChatTaskType", () => {
  it("chat 类标签（含变体与中文）判为闲聊", () => {
    for (const t of [
      "chat",
      "Chat",
      "chitchat",
      "chat-greeting",
      "闲聊",
      "打招呼",
      "问候语",
      " chat ",
    ]) {
      expect(isChatTaskType(t), t).toBe(true);
    }
  });

  it("任务类标签不误判为闲聊", () => {
    for (const t of ["dev-bugfix", "ops-inspect", "doc", "修复导出乱码"]) {
      expect(isChatTaskType(t), t).toBe(false);
    }
  });
});
