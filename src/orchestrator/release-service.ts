// 自动发布服务（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.5）：
// 确定性编排，无 LLM 参与。轮询 autoDev workflow 绑定仓库的 [autofix] MR →
// 拉真实 diff → release-policy 评估 → 命中即平台 API 自动合并（不经 agent 工具、
// 不经 force 门审批链——放行依据是纯函数策略，非模型输出）→ release_runs 落行 → 通知。
// 回报闭环：handleReleaseResult 消费宿主管线上报，推进 release_run/反馈状态机。
import { createGitPlatformApiResolver } from "../adapters/git-platform-api-resolver.js";
import type { User } from "../domain/user.js";
import { evaluateReleaseProposal, normalizeMrDiff, ReleasePolicySchema, type ReleaseVerdict } from "../domain/release-policy.js";
import { parseReleaseProposal } from "../domain/release-proposal.js";
import { ReleaseResultSchema } from "../domain/release-result.js";
import type { Agent } from "../domain/agent.js";
import { extractBranchHeadSha, parseRepositoryUrl, type GitProvider } from "../domain/git.js";
import type { Workflow } from "../domain/workflow.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { FeedbackStore } from "../ports/feedback-store.js";
import type {
  GitPlatformApi,
  GitPlatformApiResolver,
  PlatformApiResult,
} from "../ports/git-platform-api.js";
import type { Logger } from "../util/logger.js";
import type { NotificationService } from "./notification-service.js";
import type { RateLimiter } from "../ports/rate-limiter.js";
import type { ReleaseRun, ReleaseRunStore } from "../ports/release-run-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import { credentialFor, type GitPlatformToolsDeps } from "./git-platform-tools.js";

const AUTOFIX_TITLE_PREFIX = "[autofix]";
/** 单 tick 每 workflow 最多处理的 MR 数（API 用量上限） */
const MAX_MR_PER_TICK = 5;

/** 平台 MR 详情归一（gitee/github 与 gitlab 字段名分流） */
export interface MrFacts {
  number: string;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
}

export function extractMrFacts(provider: string, payload: Record<string, unknown>): MrFacts | undefined {
  const num = (v: unknown): string =>
    typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  const number = num(payload.number) || num(payload.iid);
  if (!number) return undefined;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  let headSha = "";
  let baseSha = "";
  let sourceBranch = "";
  let targetBranch = "";
  if (provider === "jihulab") {
    const refs = payload.diff_refs as Record<string, unknown> | undefined;
    headSha = str(refs?.head_sha);
    baseSha = str(refs?.base_sha);
    sourceBranch = str(payload.source_branch);
    targetBranch = str(payload.target_branch);
  } else {
    const head = payload.head as Record<string, unknown> | undefined;
    const base = payload.base as Record<string, unknown> | undefined;
    headSha = str(head?.sha);
    baseSha = str(base?.sha);
    sourceBranch = str(head?.ref);
    targetBranch = str(base?.ref);
  }
  return {
    number,
    title: str(payload.title),
    body: str(payload.body) || str(payload.description),
    headSha,
    baseSha,
    sourceBranch,
    targetBranch,
    url: str(payload.html_url) || str(payload.web_url),
  };
}

function parseJsonArray(body: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface ReleaseServiceDeps {
  workflowStore: WorkflowStore;
  agentStore: AgentStore;
  credentialSets?: CredentialSetStore;
  releaseRunStore: ReleaseRunStore;
  feedbackStore?: FeedbackStore;
  notifications?: NotificationService;
  rateLimiter: RateLimiter;
  logger: Logger;
  /** kill-switch（DONGER_AUTODEV_DISABLED 现取）：true 时 tick 空转、放行白名单失效 */
  disabled?: () => boolean;
  /** 测试注入：平台 API 客户端解析；缺省三平台内置实现 */
  platformApis?: GitPlatformApiResolver;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  now?: () => Date;
}

export interface ReleaseProcessOutcome {
  workflowId: string;
  processed: Array<{ mrNumber: string; action: "merged" | "needs_human" | "merge_failed"; reasons: string[] }>;
  skipped?: string;
}

export class ReleaseService {
  private readonly interval: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: ReleaseServiceDeps) {
    this.interval = deps.pollIntervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 平台 API 客户端（测试注入优先） */
  private apiFor(provider: GitProvider, host: string): GitPlatformApi | undefined {
    return (
      this.deps.platformApis ?? createGitPlatformApiResolver(this.deps.fetchImpl)
    )(provider, host);
  }

  /** 通知（复用 deploy 通知组目录项，用户偏好零迁移） */
  private notify(
    event: "deploy.detected" | "deploy.succeeded" | "deploy.failed",
    userIds: string[],
    title: string,
    body: string,
    dedupeKey?: string,
  ): void {
    if (!this.deps.notifications) return;
    for (const userId of [...new Set(userIds)]) {
      void this.deps.notifications
        .notify({
          event,
          recipients: [{ kind: "user", userId }],
          title: title.slice(0, 200),
          body: body.slice(0, 400),
          dedupeKey,
        })
        .catch((e: unknown) =>
          this.deps.logger.error({ err: String(e) }, "release 通知失败"),
        );
    }
  }

  /** 轮询入口：所有启用 autoDev 的工作流逐一处理；tick 串行（防重入） */
  async tick(): Promise<ReleaseProcessOutcome[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      if (this.deps.disabled?.()) return [];
      const outcomes: ReleaseProcessOutcome[] = [];
      const workflows = await this.deps.workflowStore.listAll();
      for (const wf of workflows) {
        if (!wf.enabled || !wf.autoDev?.enabled) continue;
        try {
          outcomes.push(await this.processWorkflow(wf));
        } catch (e) {
          this.deps.logger.error(
            { workflowId: wf.id, err: (e as Error).message },
            "release processWorkflow failed",
          );
        }
      }
      return outcomes;
    } finally {
      this.ticking = false;
    }
  }

  private policyOf(wf: Workflow) {
    return ReleasePolicySchema.parse(wf.autoDev?.policy ?? {});
  }

  /** 回滚冷却：最近一条记录为 rolled_back 且在冷却期内 → 跳过本轮 */
  private async inCooldown(
    wf: Workflow,
    policy: ReturnType<ReleaseService["policyOf"]>,
    now: Date,
  ): Promise<boolean> {
    if (policy.cooldownHoursOnRollback <= 0) return false;
    const runs = await this.deps.releaseRunStore.listByWorkflow(wf.id, 1).catch(() => []);
    const last = runs[0];
    if (!last || last.status !== "rolled_back") return false;
    const elapsed = now.getTime() - new Date(last.updatedAt).getTime();
    return elapsed < policy.cooldownHoursOnRollback * 3_600_000;
  }

  async processWorkflow(wf: Workflow): Promise<ReleaseProcessOutcome> {
    const outcome: ReleaseProcessOutcome = { workflowId: wf.id, processed: [] };
    const now = this.deps.now?.() ?? new Date();
    const policy = this.policyOf(wf);
    const agent = await this.deps.agentStore.get(wf.agentId);
    const repo = agent?.gitRepositories?.[0];
    if (!agent || !repo) {
      outcome.skipped = "workflow agent 未绑定仓库";
      return outcome;
    }
    const parsed = parseRepositoryUrl(repo.url);
    if (!parsed) {
      outcome.skipped = "仓库 URL 无法解析";
      return outcome;
    }
    const api = this.apiFor(repo.provider, parsed.host);
    if (!api) {
      outcome.skipped = `平台 ${repo.provider} 无 API 实现`;
      return outcome;
    }
    // 凭证桥现取（与 git 工具同链路；共享语义=workflow 属主空间）
    const credDeps = {
      user: { id: wf.ownerId } as User,
      agent,
      credentialSets: this.deps.credentialSets,
    } satisfies Pick<GitPlatformToolsDeps, "user" | "agent" | "credentialSets">;
    const credential = await credentialFor(credDeps as GitPlatformToolsDeps, repo);
    if (!credential) {
      outcome.skipped = `仓库 ${repo.name} 凭证未配置`;
      return outcome;
    }
    const token = credential.accessToken;
    const repositoryPath = parsed.repositoryPath;

    if (await this.inCooldown(wf, policy, now)) {
      outcome.skipped = "回滚冷却期内";
      return outcome;
    }

    const listed = await api.listMr({ repositoryPath, state: "opened", perPage: 20 }, token);
    if (!listed.ok) {
      outcome.skipped = `listMr 失败：${listed.body.slice(0, 120)}`;
      return outcome;
    }

    for (const mr of parseJsonArray(listed.body)) {
      if (outcome.processed.length >= MAX_MR_PER_TICK) break;
      const title = str$(mr.title);
      if (!title.startsWith(AUTOFIX_TITLE_PREFIX)) continue;
      const number = str$(mr.number) || str$(mr.iid);
      if (!number) continue;
      const existing = await this.deps.releaseRunStore.getByMr(repositoryPath, number);
      if (existing) continue; // 同 MR 终身一行
      const res = await this.processMr(wf, api, repositoryPath, number, token, policy, now);
      if (res) outcome.processed.push(res);
    }
    return outcome;
  }

  private async processMr(
    wf: Workflow,
    api: GitPlatformApi,
    repositoryPath: string,
    number: string,
    token: string,
    policy: ReturnType<ReleaseService["policyOf"]>,
    now: Date,
  ): Promise<ReleaseProcessOutcome["processed"][number] | undefined> {
    const detail = await api.getMr({ repositoryPath, number }, token);
    if (!detail.ok) {
      this.deps.logger.warn({ repositoryPath, number, err: detail.body.slice(0, 120) }, "getMr 失败，跳过");
      return undefined;
    }
    const facts = extractMrFacts(api.provider, parseJsonObject(detail.body) ?? {});
    if (!facts) return undefined;

    // 配额：滑窗 24h 近似自然日；满额不落终态行（留给下个窗口），通知管理员一次
    if (
      policy.dailyAutoMergeQuota > 0 &&
      !this.deps.rateLimiter.hit(`automerge:${wf.id}`, 24 * 3_600_000, policy.dailyAutoMergeQuota)
    ) {
      this.notify(
        "deploy.failed",
        [wf.ownerId],
        `「${wf.name}」自动合并配额已满`,
        `MR !${number} 达到每日上限 ${policy.dailyAutoMergeQuota}，今日不再自动合并（MR 保留待下个窗口）`,
        `automerge-quota:${wf.id}:${now.toISOString().slice(0, 10)}`,
      );
      return { mrNumber: number, action: "needs_human", reasons: ["每日自动合并配额已满"] };
    }

    const proposal = parseReleaseProposal(facts.body);
    const diff = await api.getMrDiff({ repositoryPath, number }, token);
    const entries = diff.ok ? normalizeMrDiff(parseJsonArray(diff.body), api.provider) : [];
    const masterHead = facts.targetBranch
      ? await api.getBranch({ repositoryPath, branch: facts.targetBranch }, token)
      : undefined;
    const masterHeadSha =
      masterHead?.ok && masterHead.body
        ? (extractBranchHeadSha(api.provider, masterHead.body) ?? "")
        : "";

    const verdict: ReleaseVerdict = evaluateReleaseProposal(
      { entries, headSha: facts.headSha, baseSha: facts.baseSha, masterHeadSha },
      policy,
    );
    if (!proposal) verdict.reasons.unshift("提案块（donger-proposal）缺失或非法");
    verdict.allow = verdict.allow && Boolean(proposal);

    const base = {
      id: crypto.randomUUID(),
      workflowId: wf.id,
      workflowRunId: null,
      feedbackId: proposal?.feedbackId ?? null,
      repositoryPath,
      mrNumber: number,
      mrUrl: facts.url,
      sourceBranch: facts.sourceBranch,
      headSha: facts.headSha,
      baseSha: facts.baseSha,
      policyVerdict: JSON.stringify(verdict),
    };

    if (!verdict.allow) {
      await this.deps.releaseRunStore.insert({
        ...base,
        status: "needs_human",
        detail: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      this.notify(
        "deploy.failed",
        [wf.ownerId],
        `「${wf.name}」自动发布策略拒绝 MR !${number}`,
        verdict.reasons.join("；").slice(0, 380),
        `release-needs-human:${repositoryPath}:${number}`,
      );
      return { mrNumber: number, action: "needs_human", reasons: verdict.reasons };
    }

    const merged = await api.mergeMr({ repositoryPath, number }, token);
    if (!merged.ok) {
      await this.deps.releaseRunStore.insert({
        ...base,
        status: "merge_failed",
        detail: JSON.stringify({ error: merged.body.slice(0, 500) }),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      this.notify(
        "deploy.failed",
        [wf.ownerId],
        `「${wf.name}」自动合并失败 MR !${number}`,
        merged.body.slice(0, 380),
        `release-merge-failed:${repositoryPath}:${number}`,
      );
      return { mrNumber: number, action: "merge_failed", reasons: [merged.body.slice(0, 200)] };
    }

    await this.deps.releaseRunStore.insert({
      ...base,
      status: "merged",
      detail: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    // 反馈推进：open→accepted（已修复待发布）；提交人与管理员双双知晓
    if (proposal) {
      const feedback = this.deps.feedbackStore
        ? await this.deps.feedbackStore.get(proposal.feedbackId).catch(() => undefined)
        : undefined;
      if (feedback && feedback.status === "open") {
        await this.deps.feedbackStore?.updateStatus(proposal.feedbackId, "accepted").catch(() => {});
      }
      if (feedback) {
        this.notify(
          "deploy.detected",
          [feedback.userId],
          "你的反馈已修复，待发布",
          `反馈「${feedback.content.slice(0, 60)}」的修复已合并（MR !${number}），发布完成后将再次通知你`,
        );
      }
    }
    this.notify(
      "deploy.detected",
      [wf.ownerId],
      `「${wf.name}」已自动合并 MR !${number}`,
      `${facts.sourceBranch} → ${facts.targetBranch}（${facts.headSha.slice(0, 8)}），等待宿主管线构建发布`,
    );
    return { mrNumber: number, action: "merged", reasons: [] };
  }

  /**
   * 宿主管线结果回收（POST /api/internal/release-result 的服务端落点）。
   * 幂等：同一 run 重复回报同状态直接成功；merged 之前的回报拒绝。
   */
  async handleReleaseResult(
    raw: unknown,
  ): Promise<{ ok: boolean; status?: number; body: Record<string, unknown> }> {
    const parsed = ReleaseResultSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, status: 400, body: { error: "payload 非法", detail: parsed.error.issues[0]?.message } };
    }
    const result = parsed.data;
    const run = await this.deps.releaseRunStore.getByHeadSha(result.repositoryPath, result.headSha);
    if (!run) {
      return { ok: false, status: 404, body: { error: "release run 不存在（headSha 未命中）" } };
    }
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    if (result.status === "build_failed") {
      // 切换前失败：生产未被触碰，维持 merged，仅记 detail（watcher 下轮重试同一 sha）
      await this.deps.releaseRunStore.updateStatus(run.id, "merged", {
        detail: JSON.stringify({ build_failed: result.reason?.slice(0, 500), imageTag: result.imageTag }),
      });
      return { ok: true, body: { status: run.status } };
    }
    if (run.status === "merged") {
      await this.deps.releaseRunStore.updateStatus(run.id, result.status, {
        detail: JSON.stringify({ imageTag: result.imageTag, slot: result.slot, reason: result.reason }),
      });
    } else {
      // 幂等回报：已 deployed/rolled_back 的重复上报直接确认
      return { ok: true, body: { status: run.status } };
    }

    const wf = await this.deps.workflowStore.get(run.workflowId);
    const adminIds = [wf?.ownerId ?? ""].filter(Boolean);
    if (result.status === "deployed") {
      const submitter = run.feedbackId
        ? (await this.deps.feedbackStore?.get(run.feedbackId).catch(() => undefined))?.userId
        : undefined;
      this.notify(
        "deploy.succeeded",
        [...adminIds, ...(submitter ? [submitter] : [])],
        `发布成功：${result.headSha.slice(0, 8)}`,
        `镜像 ${result.imageTag ?? "auto"} 已上线（槽 ${result.slot ?? "prod"}）`,
      );
      if (run.feedbackId) await this.advanceFeedback(run, "resolved");
    } else {
      this.notify(
        "deploy.failed",
        adminIds,
        `发布失败已自动回滚：${result.headSha.slice(0, 8)}`,
        (result.reason ?? "健康检查未通过").slice(0, 380),
      );
      if (run.feedbackId) await this.advanceFeedback(run, "accepted");
    }
    return { ok: true, body: { status: result.status } };
  }

  private async advanceFeedback(run: ReleaseRun, status: "resolved" | "accepted"): Promise<void> {
    if (!this.deps.feedbackStore || !run.feedbackId) return;
    await this.deps.feedbackStore.updateStatus(run.feedbackId, status).catch(() => {});
  }
}

/** 局部小工具：unknown 安全取串 */
function str$(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
