import { describe, expect, it } from "vitest";
import type { KbLibrary } from "../../src/domain/kb.js";
import { narrowAutoLearnTargets } from "../../src/orchestrator/kb-auto-learn.js";

/** 独立知识库（可写目标）收窄（specs/2026-10-01-agent-own-kb-picker-design.md §2.3） */
function lib(id: string): KbLibrary {
  return {
    id,
    ownerId: "u1",
    name: `库-${id}`,
    description: "",
    systemPrompt: "",
    builtin: false,
    personal: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

describe("narrowAutoLearnTargets", () => {
  const candidates = [lib("a"), lib("b")];

  it("未指定目标：候选集原样（既有语义——写入全部可管理绑定库）", () => {
    expect(narrowAutoLearnTargets(undefined, candidates)).toBe(candidates);
    expect(narrowAutoLearnTargets(null, candidates)).toBe(candidates);
  });

  it("目标命中候选：收窄为该库", () => {
    expect(narrowAutoLearnTargets("b", candidates)).toEqual([candidates[1]]);
  });

  it("目标悬空（已删/失权不在候选集）：回退全量候选", () => {
    expect(narrowAutoLearnTargets("gone", candidates)).toBe(candidates);
  });
});
