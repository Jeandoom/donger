// 部署轮询器：一切皆出站——donger 主动轮询 git 平台分支 HEAD（复用三平台适配器），
// diff 最近成功部署单的 sha。autoDeploy=纯通道直接执行（零 LLM）；非 auto=仅站内信通知。
// 不复用 scheduler 触发器（其绑定的 loop 必跑 agent 会话，与零 LLM 快路径语义相悖）。

import { gitPatFromValues } from "../domain/credential.js";
import { type DeployTarget, extractBranchHeadSha } from "../domain/deploy.js";
import { parseRepositoryUrl } from "../domain/git.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { DeployStore } from "../ports/deploy-store.js";
import type { GitPlatformApiResolver } from "../ports/git-platform-api.js";
import type { Logger } from "../util/logger.js";
import type { DeployExecutor } from "./deploy-executor.js";
import type { NotificationService } from "./notification-service.js";

export interface DeployPollerDeps {
  deployStore: DeployStore;
  credentialSets: CredentialSetStore;
  platformApis: GitPlatformApiResolver;
  executor: DeployExecutor;
  notifications?: NotificationService;
  logger: Logger;
  /** 轮询间隔（缺省 120s；env DONGER_DEPLOY_POLL_INTERVAL_MS） */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 120_000;

export class DeployPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly deps: DeployPollerDeps) {
    this.intervalMs = Math.max(10_000, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick());
    this.timer.unref?.();
    this.deps.logger.info({ intervalMs: this.intervalMs }, "deploy poller started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // 长 tick 重入保护（顺序轮询不并发）
    this.running = true;
    try {
      await this.pollOnce();
    } finally {
      this.running = false;
    }
  }

  /** 单轮全量轮询（导出语义：测试直调；逐 target 顺序执行防并发轰炸） */
  async pollOnce(): Promise<void> {
    const targets = await this.deps.deployStore.listEnabledTargets();
    for (const target of targets) {
      try {
        await this.pollTarget(target);
      } catch (e) {
        this.deps.logger.warn(
          { targetId: target.id, err: (e as Error).message },
          "deploy poll failed",
        );
      }
    }
  }

  /** 单目标轮询（独立方法便于单测直调） */
  async pollTarget(target: DeployTarget): Promise<void> {
    const parsed = parseRepositoryUrl(target.repoUrl);
    if (!parsed) {
      this.deps.logger.warn(
        { targetId: target.id, repoUrl: target.repoUrl },
        "deploy poll: bad repoUrl",
      );
      return;
    }
    const api = this.deps.platformApis(target.provider, parsed.host);
    if (!api) {
      this.deps.logger.warn(
        { targetId: target.id, provider: target.provider },
        "deploy poll: no api adapter",
      );
      return;
    }
    let token: string | undefined;
    if (target.gitCredentialCode) {
      const [filled] = await this.deps.credentialSets.getFilledValues(target.ownerId, [
        target.gitCredentialCode,
      ]);
      token = gitPatFromValues(filled?.values)?.accessToken;
      if (!token) {
        this.deps.logger.warn(
          { targetId: target.id, code: target.gitCredentialCode },
          "deploy poll: git credential missing",
        );
        return;
      }
    }
    const result = await api.getBranch(
      { repositoryPath: parsed.repositoryPath, branch: target.branch },
      token ?? "",
    );
    if (!result.ok) {
      this.deps.logger.warn(
        { targetId: target.id, status: result.status },
        "deploy poll: getBranch failed",
      );
      return;
    }
    const sha = extractBranchHeadSha(target.provider, result.body);
    if (!sha) {
      this.deps.logger.warn(
        { targetId: target.id },
        "deploy poll: sha not found in branch payload",
      );
      return;
    }
    const last = await this.deps.deployStore.getLastSuccessOrder(target.id);
    if (last?.sha === sha) return; // 无变化

    if (target.autoDeploy) {
      await this.deps.executor.run(target, { trigger: "poll", ref: sha });
      return;
    }
    // 生产模式（autoDeploy=false）：只通知，人工经 API / service_deploy 工具触发
    if (this.deps.notifications) {
      try {
        await this.deps.notifications.notify({
          event: "deploy.detected",
          recipients: [{ kind: "user", userId: target.ownerId }],
          title: `发现新提交待部署：${target.name}`,
          body: `${target.provider}:${target.repoUrl} 分支 ${target.branch} 有新提交 ${sha.slice(0, 8)}（当前部署 ${last?.sha?.slice(0, 8) ?? "无"}）。该目标未开启自动部署，请确认后手动触发。`,
          dedupeKey: `deploy.detected:${target.id}:${sha}`,
        });
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message }, "deploy.detected notify failed");
      }
    }
  }
}
