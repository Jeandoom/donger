import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KbLibrary } from "../../src/domain/kb.js";
import {
  applyLearnRoutes,
  type ApplyContext,
  type AutoLearnParams,
  type LearnRoutes,
} from "../../src/orchestrator/kb-auto-learn.js";
import { kbRootDir } from "../../src/util/kb-files.js";

let tmp: string;
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function lib(id: string): KbLibrary {
  return {
    id,
    ownerId: "u1",
    name: `库-${id}`,
    description: "",
    systemPrompt: "",
    builtin: false,
    personal: false,
    createdAt: "t",
    updatedAt: "t",
  };
}

function harness(opts?: { memoryRoot?: boolean; skills?: AutoLearnParams["skillCatalog"] }) {
  tmp = mkdtempSync(join(tmpdir(), "kb-al-"));
  const workspaceDir = join(tmp, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const candidateKbs = [lib("kb-1")];
  mkdirSync(kbRootDir(workspaceDir, "kb-1"), { recursive: true });
  const memoryRootDir = opts?.memoryRoot === false ? undefined : join(tmp, "mem");
  const revisions: Array<{ path: string; actorKind: string }> = [];
  const suggestions: Array<{ targetSkill: string }> = [];
  const candidates: Array<{ content: string }> = [];
  const params: AutoLearnParams = {
    user: { id: "u1" },
    conversation: { id: "conv-1" } as AutoLearnParams["conversation"],
    taskId: "t1",
    candidateKbs,
    workspaceDir,
    llm: { model: "m", baseUrl: "u", authToken: "t" },
    revisionStore: {
      record: async (input) => {
        revisions.push({ path: input.path, actorKind: input.actorKind });
      },
    },
    memoryRootDir,
    skillCatalog: opts?.skills,
    suggestionRecorder: {
      record: async (input) => {
        suggestions.push({ targetSkill: input.targetSkill });
      },
    },
    platformNoteStore: {
      appendCandidate: (content) => {
        candidates.push({ content });
      },
    },
  };
  const ctx: ApplyContext = {
    user: { id: "u1" },
    conversation: { id: "conv-1" } as ApplyContext["conversation"],
    taskId: "t1",
    candidateKbs,
    workspaceDir,
    revisionStore: params.revisionStore,
  };
  const allOn: LearnRoutes = { memory: true, kbRecord: true, skillSuggestion: true, platformNote: true };
  return { params, ctx, allOn, revisions, suggestions, candidates, memoryRootDir, workspaceDir };
}

describe("applyLearnRoutes 四路落位", () => {
  it("memory 路由：curated 落盘 + INDEX 行写入；同文件再写替换旧行不重复", async () => {
    const h = harness();
    await applyLearnRoutes(
      { routes: [{ route: "memory", action: "add", file: "npm-policy.md", title: "npm 策略坑", content: "正文", indexLine: "- [npm 策略坑](npm-policy.md) — 钩子" }] },
      h.params,
      h.allOn,
      h.ctx,
    );
    const curated = join(h.memoryRootDir!, "curated");
    expect(existsSync(join(curated, "npm-policy.md"))).toBe(true);
    expect(readFileSync(join(curated, "INDEX.md"), "utf8")).toContain("npm 策略坑");
    // 同文件更新：替换行而非追加
    await applyLearnRoutes(
      { routes: [{ route: "memory", action: "update", file: "npm-policy.md", title: "npm 策略坑 v2", content: "正文2", indexLine: "- [npm 策略坑 v2](npm-policy.md) — 新钩子" }] },
      h.params,
      h.allOn,
      h.ctx,
    );
    const index = readFileSync(join(curated, "INDEX.md"), "utf8");
    expect(index).toContain("v2");
    expect(index).not.toContain("— 钩子");
  });

  it("kbRecord 路由：写库+修订留痕；未知库报错；旧单库形态兼容", async () => {
    const h = harness();
    await applyLearnRoutes(
      { routes: [{ route: "kbRecord", kbId: "kb-1", path: "ops/r.md", summary: "s", content: "# 记录" }] },
      h.params,
      h.allOn,
      h.ctx,
    );
    expect(existsSync(join(kbRootDir(h.workspaceDir, "kb-1"), "ops", "r.md"))).toBe(true);
    expect(h.revisions).toEqual([{ path: "ops/r.md", actorKind: "auto-learn" }]);
    // 旧契约：顶层 kbId/content 直接当 kbRecord
    await applyLearnRoutes(
      { kbId: "kb-1", path: "ops/r2.md", content: "# r2", summary: "x" },
      h.params,
      h.allOn,
      h.ctx,
    );
    expect(h.revisions.length).toBe(2);
    // 未知库 → 单条即全部失败，抛错
    await expect(
      applyLearnRoutes(
        { routes: [{ route: "kbRecord", kbId: "kb-404", path: "x.md", content: "y" }] },
        h.params,
        h.allOn,
        h.ctx,
      ),
    ).rejects.toThrow(/全部失败/);
    expect(h.revisions.length).toBe(2);
  });

  it("skillSuggestion：目标在清单才留痕；platformNote 进候选池", async () => {
    const h = harness({ skills: [{ id: "p:s", name: "s", description: "d", editable: true }] });
    await applyLearnRoutes(
      {
        routes: [
          { route: "skillSuggestion", targetSkill: "s", diff: "---", rationale: "r", evidence: "e" },
          { route: "platformNote", content: "沙箱无 python" },
        ],
      },
      h.params,
      h.allOn,
      h.ctx,
    );
    expect(h.suggestions.map((s) => s.targetSkill)).toEqual(["s"]);
    expect(h.candidates.map((c) => c.content)).toEqual(["沙箱无 python"]);
    // 未知技能 → 单条即全部失败，抛错
    await expect(
      applyLearnRoutes(
        { routes: [{ route: "skillSuggestion", targetSkill: "ghost", diff: "x", rationale: "", evidence: "" }] },
        h.params,
        h.allOn,
        h.ctx,
      ),
    ).rejects.toThrow(/目标技能不在清单/);
    expect(h.suggestions.length).toBe(1);
  });

  it("路由开关关闭=跳过；全部失败才抛错", async () => {
    const h = harness();
    const off: LearnRoutes = { memory: false, kbRecord: false, skillSuggestion: false, platformNote: false };
    await applyLearnRoutes(
      {
        routes: [
          { route: "memory", file: "a.md", content: "x", indexLine: "- [a](a.md) — x", title: "a" },
          { route: "platformNote", content: "c1" },
        ],
      },
      h.params,
      off,
      h.ctx,
    );
    expect(h.candidates).toEqual([]);
    // 全部失败（未知库 + 未知技能）→ 抛
    await expect(
      applyLearnRoutes(
        {
          routes: [
            { route: "kbRecord", kbId: "kb-404", path: "x.md", content: "y" },
            { route: "skillSuggestion", targetSkill: "ghost", diff: "x", rationale: "", evidence: "" },
          ],
        },
        h.params,
        h.allOn,
        h.ctx,
      ),
    ).rejects.toThrow(/全部失败/);
  });

  it("产出为空数组/无 routes 且非旧形态 → 格式无效", async () => {
    const h = harness();
    await expect(applyLearnRoutes({ routes: [] }, h.params, h.allOn, h.ctx)).rejects.toThrow(
      /格式无效/,
    );
    await expect(applyLearnRoutes({ foo: 1 }, h.params, h.allOn, h.ctx)).rejects.toThrow(/格式无效/);
  });
});
