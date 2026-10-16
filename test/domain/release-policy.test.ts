import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROTECTED_PATH_SOURCES,
  compileProtectedPaths,
  countPatchLines,
  evaluateReleaseProposal,
  normalizeMrDiff,
  ReleasePolicySchema,
  type ReleaseProposalFacts,
} from "../../src/domain/release-policy.js";

function facts(overrides: Partial<ReleaseProposalFacts> = {}): ReleaseProposalFacts {
  return {
    entries: [
      { path: "src/adapters/web-channel.ts", additions: 10, deletions: 2, isNew: false, isDeleted: false },
    ],
    headSha: "0123456789abcdef0123456789abcdef01234567",
    baseSha: "aaaabbbbccccddddeeeeffff0000111122223333",
    masterHeadSha: "aaaabbbbccccddddeeeeffff0000111122223333",
    ...overrides,
  };
}

const policy = ReleasePolicySchema.parse({});

describe("countPatchLines", () => {
  it("统计 +/- 行并排除 +++/--- 头", () => {
    const patch = ["--- a/x", "+++ b/x", "@@ -1,2 +1,3 @@", "-old", "+new1", "+new2", " ctx"].join("\n");
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 1 });
  });

  it("空 patch 返回零", () => {
    expect(countPatchLines("")).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("normalizeMrDiff", () => {
  it("github 形态：filename/status + 显式 additions/deletions", () => {
    const payload = [
      { filename: "src/a.ts", status: "added", additions: 3, deletions: 0 },
      { filename: "src/b.ts", status: "modified", additions: 1, deletions: 4 },
      { filename: "src/c.ts", status: "removed", additions: 0, deletions: 9 },
    ];
    const out = normalizeMrDiff(payload, "github");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ path: "src/a.ts", isNew: true, isDeleted: false });
    expect(out[2]).toMatchObject({ path: "src/c.ts", isDeleted: true });
  });

  it("gitee 形态：缺省数值字段从 patch 统计", () => {
    const patch = "--- a/x\n+++ b/x\n@@\n+a\n+b\n-c\n d";
    const out = normalizeMrDiff([{ old_path: "x", new_path: "x", patch }], "gitee");
    expect(out[0]).toMatchObject({ path: "x", additions: 2, deletions: 1, isNew: false });
  });

  it("jihulab(GitLab) 形态：new_path/diff/new_file", () => {
    const diff = "--- a/y\n+++ b/y\n@@\n+n";
    const out = normalizeMrDiff([{ new_path: "y", old_path: "y", diff, new_file: true }], "jihulab");
    expect(out[0]).toMatchObject({ path: "y", additions: 1, isNew: true });
  });

  it("非数组/空项安全降级为空清单", () => {
    expect(normalizeMrDiff({}, "github")).toEqual([]);
    expect(normalizeMrDiff([null, 42, {}], "github")).toEqual([]);
  });
});

describe("evaluateReleaseProposal", () => {
  it("绿路：常规代码修复放行", () => {
    const verdict = evaluateReleaseProposal(facts(), policy);
    expect(verdict.allow).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("master 已前进（baseSha 漂移）→ 拒绝", () => {
    const verdict = evaluateReleaseProposal(facts({ masterHeadSha: "ffffeeee00001111222233334444555566667777" }), policy);
    expect(verdict.allow).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("master 已前进"))).toBe(true);
  });

  it("sha 缺失 → 拒绝", () => {
    const verdict = evaluateReleaseProposal(facts({ headSha: "", baseSha: "", masterHeadSha: "" }), policy);
    expect(verdict.allow).toBe(false);
  });

  it("diff 为空 → 拒绝", () => {
    const verdict = evaluateReleaseProposal(facts({ entries: [] }), policy);
    expect(verdict.allow).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("diff 为空"))).toBe(true);
  });

  it("文件数/行数超限 → 拒绝", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({
      path: `src/f${i}.ts`, additions: 1, deletions: 0, isNew: false, isDeleted: false,
    }));
    expect(evaluateReleaseProposal(facts({ entries: many }), policy).allow).toBe(false);
    const big = [{ path: "src/huge.ts", additions: 380, deletions: 30, isNew: false, isDeleted: false }];
    const v2 = evaluateReleaseProposal(facts({ entries: big }), policy);
    expect(v2.reasons.some((r) => r.includes("变更行数"))).toBe(true);
  });

  it("触碰红线路径 → 拒绝并点名文件与规则", () => {
    const entries = [
      { path: "src/orchestrator/default-gates.ts", additions: 1, deletions: 1, isNew: false, isDeleted: false },
    ];
    const verdict = evaluateReleaseProposal(facts({ entries }), policy);
    expect(verdict.allow).toBe(false);
    expect(verdict.reasons[0]).toContain("触碰红线路径");
    expect(verdict.reasons[0]).toContain("default-gates.ts");
  });

  it("红线路径覆盖 L2 自身机制与依赖清单/迁移/部署脚本", () => {
    const paths = [
      "src/domain/release-policy.ts",
      "package.json",
      "migrations/0001_x.sql",
      "scripts/docker-migrate.sh",
      "deploy/Dockerfile",
      ".env",
      "src/adapters/zcode-agent-runner.ts",
    ];
    for (const path of paths) {
      const verdict = evaluateReleaseProposal(
        facts({ entries: [{ path, additions: 1, deletions: 0, isNew: false, isDeleted: false }] }),
        policy,
      );
      expect(verdict.allow, path).toBe(false);
    }
  });

  it("修改既有测试文件→拒绝；新增测试文件→放行", () => {
    const modified = { path: "test/domain/foo.test.ts", additions: 2, deletions: 1, isNew: false, isDeleted: false };
    expect(evaluateReleaseProposal(facts({ entries: [modified] }), policy).allow).toBe(false);
    const added = { ...modified, isNew: true };
    expect(evaluateReleaseProposal(facts({ entries: [added] }), policy).allow).toBe(true);
  });

  it("自定义策略可放宽：关闭测试篡改防线", () => {
    const relaxed = ReleasePolicySchema.parse({ disallowModifiedTests: false, maxFiles: 15 });
    const modified = { path: "test/domain/foo.test.ts", additions: 1, deletions: 0, isNew: false, isDeleted: false };
    expect(evaluateReleaseProposal(facts({ entries: [modified] }), relaxed).allow).toBe(true);
  });

  it("重复原因去重", () => {
    const entries = [
      { path: "migrations/a.sql", additions: 1, deletions: 0, isNew: false, isDeleted: false },
      { path: "migrations/b.sql", additions: 1, deletions: 0, isNew: false, isDeleted: false },
    ];
    const verdict = evaluateReleaseProposal(facts({ entries }), policy);
    expect(verdict.reasons.filter((r) => r.startsWith("触碰红线路径")).length).toBe(2);
  });
});

describe("compileProtectedPaths", () => {
  it("非法正则 source 跳过并产出 warning", () => {
    const bad = ReleasePolicySchema.parse({ protectedPaths: ["([bad"] });
    const { patterns, warnings } = compileProtectedPaths(bad);
    expect(patterns).toHaveLength(0);
    expect(warnings[0]).toContain("编译失败");
  });

  it("缺省红线路径清单非空（自保护含 L2 机制文件）", () => {
    expect(DEFAULT_PROTECTED_PATH_SOURCES.length).toBeGreaterThan(15);
    const { patterns } = compileProtectedPaths(policy);
    expect(patterns.length).toBe(DEFAULT_PROTECTED_PATH_SOURCES.length);
  });
});
