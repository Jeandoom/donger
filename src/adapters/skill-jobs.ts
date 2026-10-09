import { randomUUID } from "node:crypto";
import type { SkillPack } from "../domain/skill-pack.js";
import type { InstallGitReq, SkillInstaller } from "../ports/skill-installer.js";
import { SkillInstallError } from "../util/errors.js";

/**
 * 技能安装/更新任务化（2026-10 体验轮）：git clone 在 HTTP 请求内联 await 最长 120s，
 * UI 只能靠按钮文字硬扛——任务化后前端立即拿 jobId 轮询进度（阶段文案 + 取消）。
 * 进程内内存表（单实例部署口径）；每用户并发上限防滥用；完成任务 TTL 后回收。
 */

export type SkillJobOp = "install-git" | "install-upload" | "install-paste" | "update";

export type SkillJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface SkillJobView {
  id: string;
  kind: SkillJobOp;
  status: SkillJobStatus;
  /** 人读阶段文案（running 时有意义，如「正在克隆仓库…」） */
  stage: string;
  error?: string;
  /** SkillInstallError.code（CANCELLED/GIT_CLONE_FAILED/CREDENTIAL_TOKEN_MISSING…） */
  errorCode?: string;
  /** 成功时返回 packId（前端 reload packs 即可，无需内嵌 pack 全量） */
  packId?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

interface InternalJob extends SkillJobView {
  userId: string;
  controller: AbortController;
}

/** 每用户同时进行中的任务上限（正常使用到不了；防脚本刷） */
const MAX_ACTIVE_PER_USER = 3;
/** 已完结任务保留时长（内存认知生命周期，前端轮询早于该值取结果） */
const FINISHED_TTL_MS = 30 * 60_000;
const MAX_KEEP_JOBS = 200;

export interface SkillJobRequest {
  op: SkillJobOp;
  source?: Record<string, unknown>;
  id?: string;
  filename?: string;
  content?: string;
}

export class SkillJobRunner {
  private readonly jobs = new Map<string, InternalJob>();

  constructor(
    private readonly installer: SkillInstaller,
    private readonly hooks?: { skillRepoSync?: { onChanged(userId: string): void } },
  ) {}

  /** 入队并异步执行；超并发上限抛 Error（路由转 429） */
  enqueue(userId: string, req: SkillJobRequest): string {
    const active = [...this.jobs.values()].filter(
      (j) => j.userId === userId && (j.status === "queued" || j.status === "running"),
    );
    if (active.length >= MAX_ACTIVE_PER_USER) {
      throw new SkillInstallError(
        "TOO_MANY_JOBS",
        `已有 ${active.length} 个安装/更新任务在进行中，请等待完成或取消后再试`,
      );
    }
    const now = new Date().toISOString();
    const job: InternalJob = {
      id: randomUUID(),
      userId,
      kind: req.op,
      status: "queued",
      stage: "排队中…",
      controller: new AbortController(),
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    void this.execute(job, userId, req);
    return job.id;
  }

  /** 非本人或不存在返回 undefined（路由 404，不区分两种情形防探测） */
  view(userId: string, jobId: string): SkillJobView | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return undefined;
    return this.snapshot(job);
  }

  /** 请求取消：git 子进程被 kill / 阶段边界中止；任务尚未结束时返回 true */
  cancel(userId: string, jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return false;
    if (job.status === "queued" || job.status === "running") {
      job.controller.abort();
      return true;
    }
    return false;
  }

  private snapshot(job: InternalJob): SkillJobView {
    const { userId: _userId, controller: _controller, ...view } = job;
    return view;
  }

  private touch(job: InternalJob, patch: Partial<SkillJobView>): void {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  }

  private async execute(job: InternalJob, userId: string, req: SkillJobRequest): Promise<void> {
    const signal = job.controller.signal;
    const onStage = (stage: string) => this.touch(job, { stage, status: "running" });
    try {
      this.touch(job, { status: "running" });
      let pack: SkillPack;
      switch (req.op) {
        case "install-git": {
          const src = (req.source ?? {}) as unknown as InstallGitReq;
          if (!src.url?.trim()) throw new SkillInstallError("GIT_URL_INVALID", "Git 来源缺少 url");
          pack = await this.installer.installFromGit(userId, src, { onStage, signal });
          break;
        }
        case "install-upload": {
          onStage("正在解析上传文档…");
          if (!req.content) throw new SkillInstallError("UPLOAD_EMPTY", "缺少文件内容");
          pack = await this.installer.installFromUpload(userId, {
            filename: req.filename ?? "skill.md",
            content: req.content,
          });
          this.hooks?.skillRepoSync?.onChanged(userId);
          break;
        }
        case "install-paste": {
          onStage("正在解析粘贴内容…");
          const src = (req.source ?? {}) as { content?: string; slug?: string };
          if (!src.content?.trim()) {
            throw new SkillInstallError("PASTE_EMPTY", "缺少 SKILL.md 内容");
          }
          pack = await this.installer.installFromPaste(userId, {
            content: src.content,
            slug: src.slug,
          });
          this.hooks?.skillRepoSync?.onChanged(userId);
          break;
        }
        case "update": {
          if (!req.id) throw new SkillInstallError("PACK_NOT_FOUND", "缺少 pack id");
          pack = await this.installer.update(userId, req.id, { onStage, signal });
          break;
        }
      }
      this.touch(job, {
        status: "done",
        stage: "完成",
        packId: pack.id,
        finishedAt: new Date().toISOString(),
      });
    } catch (e) {
      const cancelled =
        signal.aborted || (e instanceof SkillInstallError && e.code === "CANCELLED");
      if (cancelled) {
        this.touch(job, {
          status: "cancelled",
          stage: "已取消",
          error: "已取消",
          errorCode: "CANCELLED",
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      this.touch(job, {
        status: "failed",
        stage: "失败",
        error: (e as Error).message,
        errorCode: e instanceof SkillInstallError ? e.code : "UNKNOWN",
        finishedAt: new Date().toISOString(),
      });
    } finally {
      this.prune();
    }
  }

  /** 回收：完结超 TTL 或总量超上限的旧任务出表（活跃任务永不回收） */
  private prune(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const terminal = job.status !== "queued" && job.status !== "running";
      if (
        terminal &&
        job.finishedAt !== undefined &&
        now - Date.parse(job.finishedAt) > FINISHED_TTL_MS
      ) {
        this.jobs.delete(id);
      }
    }
    if (this.jobs.size <= MAX_KEEP_JOBS) return;
    const terminal = [...this.jobs.values()]
      .filter((j) => j.status !== "queued" && j.status !== "running")
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    for (const job of terminal.slice(0, this.jobs.size - MAX_KEEP_JOBS)) {
      this.jobs.delete(job.id);
    }
  }
}
