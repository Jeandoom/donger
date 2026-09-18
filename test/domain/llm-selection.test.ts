import { describe, expect, it } from "vitest";
import { agentModelRefs, isRefAllowed, resolveLlmOptions } from "../../src/domain/llm-selection.js";
import { isModelRef, parseModelRef } from "../../src/domain/model-ref.js";

const PROVIDERS = [
  { id: "p1", name: "我的智谱", models: ["glm-4.6", "glm-4.5"] },
  { id: "p2", name: "DS", models: ["deepseek-chat"] },
];
const PRESETS = [{ id: "0", name: "GLM", model: "glm-4.6" }];
const BASE = {
  providers: PROVIDERS,
  presets: PRESETS,
  systemDefaultModel: "glm-4.6",
};

describe("parseModelRef", () => {
  it("三种合法形态", () => {
    expect(parseModelRef("system")).toEqual({ kind: "system" });
    expect(parseModelRef("preset:0")).toEqual({ kind: "preset", id: "0" });
    expect(parseModelRef("provider:p1:glm-4.6")).toEqual({
      kind: "provider",
      providerId: "p1",
      model: "glm-4.6",
    });
  });
  it("非法形态返回 undefined", () => {
    for (const raw of [
      "",
      "preset:",
      "provider:",
      "provider:p1:",
      "provider::m",
      "foo:bar",
      "system:x",
    ]) {
      expect(parseModelRef(raw), raw).toBeUndefined();
    }
    expect(isModelRef("provider:p1:glm-4.6")).toBe(true);
    expect(isModelRef("bad")).toBe(false);
  });
});

describe("resolveLlmOptions", () => {
  it("未配置范围：全量（system + presets + 我的 provider 模型）", () => {
    const { options, restricted } = resolveLlmOptions({ ...BASE, agent: null });
    expect(restricted).toBe(false);
    expect(options.map((o) => o.ref)).toEqual([
      "system",
      "preset:0",
      "provider:p1:glm-4.6",
      "provider:p1:glm-4.5",
      "provider:p2:deepseek-chat",
    ]);
  });

  it("agent 配置范围：只出范围内且可用的项（restricted=true）", () => {
    const { options, restricted } = resolveLlmOptions({
      ...BASE,
      agent: { llm: { modelRefs: ["system", "provider:p2:deepseek-chat"] } },
    });
    expect(restricted).toBe(true);
    expect(options.map((o) => o.ref)).toEqual(["system", "provider:p2:deepseek-chat"]);
  });

  it("过滤降级：引用不属于当前用户的 provider（共享场景）或失效 preset 被剔除", () => {
    const { options, restricted } = resolveLlmOptions({
      ...BASE,
      agent: {
        llm: { modelRefs: ["provider:owner-only:m1", "preset:gone", "system"] },
      },
    });
    expect(restricted).toBe(true);
    expect(options.map((o) => o.ref)).toEqual(["system"]);
  });

  it("全部失效：视为未配置（全量），避免会话无模型可选", () => {
    const { options, restricted } = resolveLlmOptions({
      ...BASE,
      agent: { llm: { modelRefs: ["provider:owner-only:m1", "preset:gone"] } },
    });
    expect(restricted).toBe(false);
    expect(options.length).toBe(5);
  });

  it("provider 引用模型不在清单内剔除", () => {
    const { options } = resolveLlmOptions({
      ...BASE,
      agent: { llm: { modelRefs: ["provider:p1:no-such-model"] } },
    });
    expect(options.map((o) => o.ref)).toEqual([
      "system",
      "preset:0",
      "provider:p1:glm-4.6",
      "provider:p1:glm-4.5",
      "provider:p2:deepseek-chat",
    ]);
  });
});

describe("agentModelRefs（范围与默认分离）", () => {
  it("只取 modelRefs；presetId 是默认语义不构成范围（存量 agent 不被限制）", () => {
    expect(agentModelRefs({ llm: { presetId: "0" } })).toEqual([]);
    expect(agentModelRefs({ llm: { presetId: "0", modelRefs: ["system", "preset:0"] } })).toEqual([
      "system",
      "preset:0",
    ]);
    expect(agentModelRefs(null)).toEqual([]);
    expect(agentModelRefs({ llm: {} })).toEqual([]);
  });

  it("isRefAllowed：未配置范围恒真；配置后按字面", () => {
    expect(isRefAllowed({ llm: {} }, "anything")).toBe(true);
    expect(isRefAllowed({ llm: { presetId: "0" } }, "system")).toBe(true);
    expect(isRefAllowed({ llm: { modelRefs: ["preset:0"] } }, "preset:0")).toBe(true);
    expect(isRefAllowed({ llm: { modelRefs: ["preset:0"] } }, "system")).toBe(false);
  });
});
