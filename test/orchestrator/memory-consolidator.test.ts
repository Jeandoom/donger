import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consolidateMemory,
  runConsolidationCycle,
} from "../../src/orchestrator/memory-consolidator.js";
import { kbRootDir } from "../../src/util/kb-files.js";

let tmp: string;
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function seedPersonalLibrary(opts?: {
  oldType?: string;
  created?: string;
  noMemory?: boolean;
}): { workspaceDir: string; kbId: string; ownerId: string } {
  tmp = mkdtempSync(join(tmpdir(), "mem-cons-"));
  const workspaceDir = join(tmp, "ws");
  const kbId = "kb-personal";
  const ownerId = "u1";
  mkdirSync(workspaceDir, { recursive: true });
  if (!opts?.noMemory) {
    const curated = join(kbRootDir(workspaceDir, kbId), "memory", "curated");
    mkdirSync(curated, { recursive: true });
    const created = opts?.created ?? "2026-01-01";
    const type = opts?.oldType ?? "project";
    writeFileSync(
      join(curated, "old-entry.md"),
      `---\ntype: ${type}\ncreated: ${created}\n---\n# 旧条目\n\n正文`,
      "utf8",
    );
    writeFileSync(
      join(curated, "fresh.md"),
      "---\ntype: user\ncreated: 2026-10-14\n---\n# 新条目",
      "utf8",
    );
    writeFileSync(
      join(curated, "INDEX.md"),
      "- [旧条目](old-entry.md) — 钩子\n- [新条目](fresh.md) — 钩子\n- [孤儿](gone.md) — 已删\n",
      "utf8",
    );
  }
  return { workspaceDir, kbId, ownerId };
}

describe("consolidateMemory", () => {
  it("超期非 project 条目归档；project/新条目保留；INDEX 清孤儿行", () => {
    const h = seedPersonalLibrary({ oldType: "user", created: "2026-01-01" });
    const r = consolidateMemory({ id: h.kbId, ownerId: h.ownerId }, h.workspaceDir, {});
    expect(r?.archived).toBe(1);
    const curated = join(kbRootDir(h.workspaceDir, h.kbId), "memory", "curated");
    expect(readdirSync(curated).sort()).toEqual(["INDEX.md", "fresh.md"]);
    expect(readdirSync(join(curated, "..", "archive"))).toContain("old-entry.md");
    const index = readFileSync(join(curated, "INDEX.md"), "utf8");
    expect(index).toContain("fresh.md");
    expect(index).not.toContain("gone.md");
    expect(index).not.toContain("old-entry.md");
  });

  it("type=project 豁免归档", () => {
    const h = seedPersonalLibrary({ oldType: "project", created: "2026-01-01" });
    const r = consolidateMemory({ id: h.kbId, ownerId: h.ownerId }, h.workspaceDir, {});
    expect(r?.archived).toBe(0);
  });

  it("无 memory 目录返回 undefined", () => {
    const h = seedPersonalLibrary({ noMemory: true });
    expect(consolidateMemory({ id: h.kbId, ownerId: h.ownerId }, h.workspaceDir, {})).toBeUndefined();
  });
});

describe("runConsolidationCycle", () => {
  it("只处理 personal 库；idleCheck=false 不跑；revision+notify 触发", async () => {
    const h = seedPersonalLibrary({ oldType: "user", created: "2026-01-01" });
    const revisions: string[] = [];
    const notifications: Array<{ userId: string }> = [];
    const deps = {
      kbLibraryStore: {
        listAll: async () => [
          { id: h.kbId, ownerId: h.ownerId, personal: true },
          { id: "kb-other", ownerId: "u2", personal: false },
        ],
      },
      workspaceDir: h.workspaceDir,
      revisionStore: {
        record: async (input: { actorKind: string }) => {
          revisions.push(input.actorKind);
        },
      },
      notify: (input: { userId: string }) => {
        notifications.push({ userId: input.userId });
      },
      idleCheck: () => true,
    };
    const results = await runConsolidationCycle(deps);
    expect(results.length).toBe(1);
    expect(results[0]?.archived).toBe(1);
    expect(revisions).toEqual(["memory-consolidation"]);
    // 未超限 → 不通知
    expect(notifications.length).toBe(0);
  });

  it("idleCheck 拒绝 → 空跑", async () => {
    const h = seedPersonalLibrary({ oldType: "user", created: "2026-01-01" });
    const results = await runConsolidationCycle({
      kbLibraryStore: {
        listAll: async () => [{ id: h.kbId, ownerId: h.ownerId, personal: true }],
      },
      workspaceDir: h.workspaceDir,
      idleCheck: () => false,
    });
    expect(results).toEqual([]);
  });
});
