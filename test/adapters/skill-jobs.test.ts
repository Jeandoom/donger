import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillJobRunner } from "../../src/adapters/skill-jobs.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { SkillInstallHooks } from "../../src/ports/skill-installer.js";
import { SkillInstallError } from "../../src/util/errors.js";

const USER = "u1";

function fakePack(id = "pack-1"): SkillPack {
  return {
    id,
    userId: USER,
    slug: "demo",
    name: "demo",
    description: "",
    source: { kind: "paste" },
    installedPath: ".skills/demo",
    enabled: true,
    builtin: false,
    createdAt: "",
    updatedAt: "",
  };
}

/** 可编排的假 installer：git 安装按 hooks 推进并可在克隆中挂起（等 release） */
function fakeInstaller() {
  let releaseClone: (() => void) | null = null;
  const stages: string[] = [];
  const installer = {
    async installFromGit(
      _userId: string,
      _req: { url?: string },
      hooks: SkillInstallHooks = {},
    ): Promise<SkillPack> {
      hooks.onStage?.("正在克隆仓库…");
      stages.push("clone");
      await new Promise<void>((resolve) => {
        releaseClone = resolve;
        hooks.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      if (hooks.signal?.aborted) throw new Error("Git 操作已取消");
      hooks.onStage?.("正在解析技能清单…");
      stages.push("scan");
      return fakePack();
    },
    async installFromUpload(): Promise<SkillPack> {
      return fakePack("pack-upload");
    },
    async installFromPaste(): Promise<SkillPack> {
      return fakePack("pack-paste");
    },
    async installBuiltin(): Promise<SkillPack> {
      return fakePack("pack-builtin");
    },
    async uninstall(): Promise<void> {},
    async update(
      _userId: string,
      packId: string,
      hooks: SkillInstallHooks = {},
    ): Promise<SkillPack> {
      if (packId === "boom") throw new SkillInstallError("GIT_PULL_FAILED", "更新失败详情");
      hooks.onStage?.("正在拉取上游更新…");
      return fakePack(packId);
    },
    async readSkillDoc(): Promise<string> {
      return "# doc";
    },
    async updateSkillDoc(): Promise<SkillPack> {
      return fakePack();
    },
  };
  return {
    installer: installer as unknown as ConstructorParameters<typeof SkillJobRunner>[0],
    releaseClone: () => releaseClone?.(),
    stages,
  };
}

afterEach(() => {
  // 无全局状态需要清理（jobs 表随 runner 实例）
});

describe("SkillJobRunner", () => {
  it("全生命周期：queued → running(阶段) → done，view 携带 packId", async () => {
    const { installer } = fakeInstaller();
    const runner = new SkillJobRunner(installer);
    const jobId = runner.enqueue(USER, {
      op: "install-paste",
      source: { content: "---\nname: demo\n---\n# x" },
    });
    const view = runner.view(USER, jobId);
    expect(view).toBeTruthy();
    await vi.waitUntil(() => runner.view(USER, jobId)?.status === "done");
    const done = runner.view(USER, jobId);
    expect(done?.status).toBe("done");
    expect(done?.packId).toBe("pack-paste");
    expect(done?.errorCode).toBeUndefined();
  });

  it("clone 挂起时取消：任务终结为 cancelled（errorCode=CANCELLED）", async () => {
    const { installer, releaseClone } = fakeInstaller();
    const runner = new SkillJobRunner(installer);
    const jobId = runner.enqueue(USER, { op: "install-git", source: { url: "https://x/y.git" } });
    await vi.waitUntil(() => runner.view(USER, jobId)?.stage.includes("克隆"));
    expect(runner.cancel(USER, jobId)).toBe(true);
    await vi.waitUntil(() => runner.view(USER, jobId)?.status === "cancelled");
    const view = runner.view(USER, jobId);
    expect(view?.errorCode).toBe("CANCELLED");
    releaseClone();
  });

  it("失败任务携带结构化 code（安装错误不再只有 message）", async () => {
    const { installer } = fakeInstaller();
    const runner = new SkillJobRunner(installer);
    const jobId = runner.enqueue(USER, { op: "update", id: "boom" });
    await vi.waitUntil(() => runner.view(USER, jobId)?.status === "failed");
    const view = runner.view(USER, jobId);
    expect(view?.errorCode).toBe("GIT_PULL_FAILED");
    expect(view?.error).toContain("更新失败详情");
  });

  it("归属隔离：他人查看/取消拿不到（undefined/false）", async () => {
    const { installer } = fakeInstaller();
    const runner = new SkillJobRunner(installer);
    const jobId = runner.enqueue(USER, { op: "install-upload", filename: "a.md", content: "x" });
    await vi.waitUntil(() => runner.view(USER, jobId)?.status === "done");
    expect(runner.view("u2", jobId)).toBeUndefined();
    expect(runner.cancel("u2", jobId)).toBe(false);
  });

  it("并发上限：同用户超过 3 个活跃任务拒绝入队", async () => {
    const { installer } = fakeInstaller();
    const runner = new SkillJobRunner(installer);
    const ids = [1, 2, 3].map(() =>
      runner.enqueue(USER, { op: "install-git", source: { url: "https://x/y.git" } }),
    );
    expect(ids).toHaveLength(3);
    expect(() => runner.enqueue(USER, { op: "update", id: "p" })).toThrow(/任务在进行中/);
    for (const id of ids) runner.cancel(USER, id);
  });
});
