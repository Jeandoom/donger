// Git 触发器看护（spec 2026-09-30-deploy-ops-loop-design §6；由 L1 DeployPoller 改造）：
// 一切皆出站——平台定时轮询 git 触发器的分支 HEAD，相对 lastState 出现新提交即
// fire 其绑定的 enabled Loop（agent 会话，「每次新提交触发一次」）。首见只建立基线
// 不触发；查询失败 fail-open（log 继续）。不进 scheduler 触发器体系（其 source 是
// 无状态 matcher 模型，与「变化即触发」语义相悖，故为第四种触发器类型的看护者）。

import { gitPatFromValues } from "../domain/credential.js";
import { extractBranchHeadSha, parseRepositoryUrl } from "../domain/git.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { GitPlatformApiResolver } from "../ports/git-platform-api.js";
import type { LoopStore } from "../ports/loop-store.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import type { Logger } from "../util/logger.js";
import type { LoopRunner } from "./loop-runner.js";

export interface GitWatcherDeps {
  triggerStore: TriggerStore;
  workflowStore: WorkflowStore;
  loopStore: LoopStore;
  loopRunner: LoopRunner;
  credentialSets: CredentialSetStore;
  platformApis: GitPlatformApiResolver;
  logger: Logger;
  /** 轮询间隔毫秒（缺省 120s；config deployPollIntervalMs） */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 120_000;

/** 单个 git 触发器的 HEAD 查询结果（测试直调用） */
export interface GitHeadSnapshot {
  sha?: string;
  error?: string;
}

export class GitWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly deps: GitWatcherDeps) {
    this.intervalMs = Math.max(10_000, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick());
    this.timer.unref?.();
    this.deps.logger.info({ intervalMs: this.intervalMs }, "git watcher started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // 长 tick 重入保护
    this.running = true;
    try {
      await this.watchOnce();
    } finally {
      this.running = false;
    }
  }

  /** 单轮：收集 enabled loop 引用的 git 触发器，逐触发器查一次 HEAD、逐 loop fire */
  async watchOnce(): Promise<void> {
    const loops = await this.deps.loopStore.listEnabled();
    // triggerId → 引用它的 enabled loop 列表
    const byTrigger = new Map<string, string[]>();
    for (const loop of loops) {
      const wf = await this.deps.workflowStore.get(loop.workflowId);
      if (wf?.triggerId) {
        const list = byTrigger.get(wf.triggerId) ?? [];
        list.push(loop.id);
        byTrigger.set(wf.triggerId, list);
      }
    }
    for (const [triggerId, loopIds] of byTrigger) {
      try {
        await this.watchTrigger(triggerId, loopIds);
      } catch (e) {
        this.deps.logger.warn(
          { triggerId, err: (e as Error).message },
          "git watcher: trigger check failed",
        );
      }
    }
  }

  private async watchTrigger(triggerId: string, loopIds: string[]): Promise<void> {
    const t = await this.deps.triggerStore.get(triggerId);
    if (t?.type !== "git" || !t.git) return;
    const snapshot = await this.fetchHead(t.git, t.ownerId);
    if (snapshot.error) {
      this.deps.logger.warn({ triggerId, err: snapshot.error }, "git watcher: fetch head failed");
      return;
    }
    const sha = snapshot.sha;
    if (!sha) return;
    const last = await this.deps.triggerStore.getGitLastSha(triggerId);
    // 先更新基线再 fire（fire 是入队不等待，顺序无竞态； watcher 单线程 tick）
    await this.deps.triggerStore.setGitLastSha(triggerId, sha);
    if (!last) {
      this.deps.logger.info({ triggerId, sha: sha.slice(0, 8) }, "git watcher: baseline set");
      return; // 首见：建立基线，不触发
    }
    if (last === sha) return;
    const sourceOutput = JSON.stringify({
      triggerId,
      triggerName: t.name,
      provider: t.git.provider,
      repoUrl: t.git.repoUrl,
      branch: t.git.branch,
      previousSha: last,
      sha,
    });
    this.deps.logger.info(
      { triggerId, loops: loopIds.length, sha: sha.slice(0, 8) },
      "git watcher: head changed, firing loops",
    );
    for (const loopId of loopIds) {
      await this.deps.loopRunner.fire(loopId, sourceOutput, "git", triggerId);
    }
  }

  /** HEAD 查询（独立方法供测试与 testTrigger 复用） */
  async fetchHead(
    git: {
      provider: "github" | "gitee" | "jihulab";
      repoUrl: string;
      branch: string;
      credentialCode?: string;
    },
    ownerId: string,
  ): Promise<GitHeadSnapshot> {
    const parsed = parseRepositoryUrl(git.repoUrl);
    if (!parsed) return { error: "repoUrl 非法" };
    const api = this.deps.platformApis(git.provider, parsed.host);
    if (!api) return { error: `平台 ${git.provider} 无 API 适配` };
    let token = "";
    if (git.credentialCode) {
      const [filled] = await this.deps.credentialSets.getFilledValues(ownerId, [
        git.credentialCode,
      ]);
      token = gitPatFromValues(filled?.values)?.accessToken ?? "";
      if (!token) return { error: `git 凭证缺失（模板 ${git.credentialCode}）` };
    }
    const result = await api.getBranch(
      { repositoryPath: parsed.repositoryPath, branch: git.branch },
      token,
    );
    if (!result.ok) return { error: `getBranch 失败（HTTP ${result.status}）` };
    const sha = extractBranchHeadSha(git.provider, result.body);
    if (!sha) return { error: "分支 payload 中未找到 sha" };
    return { sha };
  }
}
