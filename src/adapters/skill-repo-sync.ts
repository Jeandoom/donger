// 用户技能仓库同步服务：把自建技能 pack（paste/upload 源）镜像到用户绑定的 git 仓库，
// 管理（启停/卸载）与优化（update_skill）均以提交历史留痕。
// 定位（specs/2026-09-20-skill-repo-git-sync-design.md）：仓库是镜像/历史账本而非
// pack source——SQLite 仍是运行时事实源，本服务单向（本地 → 仓库）镜像。
// 安全：token 经凭证桥现取 + 临时 AskPass 注入（不进 env/prompt/返回值）；
// push 强制 --no-verify 防 pre-push hook 触碰凭证；错误输出统一脱敏。
// 可靠性：每用户串行队列；同步失败仅落 lastSyncStatus，不阻塞、不回滚本地技能。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitPatFromValues } from "../domain/credential.js";
import type { SkillPack } from "../domain/skill-pack.js";
import type { User } from "../domain/user.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { UserSkillRepoStore } from "../ports/user-skill-repo-store.js";
import { type GitProcessCredential, runGit, sanitizeGitError } from "../util/git-process.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_LONG_PATH = "core.longpaths=true";
const SYNC_IDENTITY = [
  "-c",
  "user.name=donger-skill-sync",
  "-c",
  "user.email=skill-sync@donger.local",
];
/** lastSyncError 落库截断（sanitizeGitError 已限 500，这里再收一档防刷屏） */
const ERROR_CLIP = 300;

export interface SkillRepoSyncDeps {
  repoStore: UserSkillRepoStore;
  packStore: SkillPackStore;
  credentialSets?: CredentialSetStore;
  getHomeDir: (userId: string) => string;
  /** 测试注入 git 执行器；缺省 runGit（AskPass 凭证注入） */
  gitRunner?: typeof runGit;
}

export interface SkillRepoSyncOutcome {
  ok: boolean;
  message: string;
}

/** 手动测试连接 / 配置弹窗「测试连接」用的未保存入参 */
export interface SkillRepoVerifyTarget {
  repoUrl: string;
  credentialCode: string;
}

export class SkillRepoSyncService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SkillRepoSyncDeps) {}

  /** 技能变更钩子：入队串行同步；失败仅落状态、不上抛（不阻塞技能主流程） */
  onChanged(userId: string): void {
    void this.syncNow(userId).catch((e: unknown) => {
      console.error("[skill-repo-sync]", (e as Error).message);
    });
  }

  /** 等待该用户排队中的同步全部完成（测试/关停用） */
  async idle(userId: string): Promise<void> {
    await this.queues.get(userId);
  }

  /** 连通性测试（只读 ls-remote，不落盘、不改状态）。target 缺省用已保存配置。 */
  async verify(
    user: Pick<User, "id">,
    target?: SkillRepoVerifyTarget,
  ): Promise<SkillRepoSyncOutcome> {
    const cfg = target
      ? { repoUrl: target.repoUrl, credentialCode: target.credentialCode }
      : await this.deps.repoStore.get(user.id);
    if (!cfg) return { ok: false, message: "未配置技能仓库" };
    // https-only 校验在 HTTP 入口（skill-repo-api）执行；service 层保留本地路径通道供离线/测试
    const credential = await this.resolveCredential(user.id, cfg.credentialCode, cfg.repoUrl);
    if (!credential) return { ok: false, message: credentialMissingHint(cfg.credentialCode) };
    const r = await this.git(["ls-remote", cfg.repoUrl, "HEAD"], credential);
    if (r.code !== 0) {
      return {
        ok: false,
        message: `连接失败：${sanitizeGitError(r.stderr || r.stdout || "未知错误")}`,
      };
    }
    const refs = r.stdout.trim().length > 0 ? 1 : 0;
    return {
      ok: true,
      message: refs > 0 ? "连接成功（远端已有内容）" : "连接成功（远端为空仓库，首次同步将初始化）",
    };
  }

  /** 解绑：清理本地工作副本 + 删配置。 */
  async forget(userId: string): Promise<void> {
    rmSync(join(this.deps.getHomeDir(userId), ".skill-repo-cache"), {
      recursive: true,
      force: true,
    });
    await this.deps.repoStore.remove(userId);
  }

  /** 全量同步（串行排队执行；手动按钮与自动钩子共用）。 */
  syncNow(userId: string): Promise<SkillRepoSyncOutcome> {
    return this.enqueue(userId, () => this.runSync(userId));
  }

  // ---- 内部 ----

  private enqueue<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      userId,
      next.catch(() => undefined),
    );
    return next;
  }

  private git(args: string[], credential?: GitProcessCredential) {
    return (this.deps.gitRunner ?? runGit)(args, credential, GIT_TIMEOUT_MS);
  }

  private async runSync(userId: string): Promise<SkillRepoSyncOutcome> {
    const cfg = await this.deps.repoStore.get(userId);
    if (!cfg) return { ok: false, message: "未配置技能仓库" };
    if (!cfg.enabled) {
      await this.recordStatus(userId, "skipped", "同步已停用");
      return { ok: true, message: "同步已停用，已跳过" };
    }
    try {
      const credential = await this.resolveCredential(userId, cfg.credentialCode, cfg.repoUrl);
      if (!credential) throw new Error(credentialMissingHint(cfg.credentialCode));

      const workdir = await this.ensureWorktree(userId, cfg.repoUrl, cfg.branch, credential);
      const { packCount, skillCount } = await this.mirrorPacks(userId, workdir);

      await this.git(["-C", workdir, "-c", GIT_LONG_PATH, "add", "-A"]);
      const diff = await this.git(["-C", workdir, "diff", "--cached", "--quiet"]);
      if (diff.code === 0) {
        await this.recordStatus(userId, "ok", undefined);
        return { ok: true, message: `无变更（${packCount} 个技能包已一致）` };
      }
      await this.git([
        "-C",
        workdir,
        ...SYNC_IDENTITY,
        "commit",
        "-m",
        `skills sync: ${packCount} packs / ${skillCount} skills`,
      ]);
      await this.pushWithRetry(workdir, cfg.branch, credential);
      await this.recordStatus(userId, "ok", undefined);
      return { ok: true, message: `已同步 ${packCount} 个技能包 / ${skillCount} 个技能` };
    } catch (e) {
      const message = (e as Error).message;
      await this.recordStatus(userId, "failed", message);
      return { ok: false, message };
    }
  }

  /** 克隆/复用工作副本；内容每次全量重建（镜像语义，删改自然收敛） */
  private async ensureWorktree(
    userId: string,
    repoUrl: string,
    branch: string,
    credential: GitProcessCredential,
  ): Promise<string> {
    const workdir = join(this.deps.getHomeDir(userId), ".skill-repo-cache");
    if (existsSync(join(workdir, ".git"))) return workdir;
    rmSync(workdir, { recursive: true, force: true });
    const temporary = `${workdir}.clone-${crypto.randomUUID()}`;
    const clone = await this.git(
      ["-c", GIT_LONG_PATH, "clone", "--depth", "1", "--branch", branch, repoUrl, temporary],
      credential,
    );
    if (clone.code !== 0) {
      // 空仓库（无分支可跟踪）走兜底：本地 init + 关联远端，首次同步推送初始提交。
      // 其他失败（地址/凭证/分支错）也会落到这里，最终在 push 环节以脱敏错误浮出。
      rmSync(temporary, { recursive: true, force: true });
      const init = await this.git(["init", temporary]);
      if (init.code !== 0) {
        throw new Error(
          `仓库克隆失败：${sanitizeGitError(clone.stderr || clone.stdout || "未知错误")}（检查地址/分支/凭证写权限）`,
        );
      }
      await this.git(["-C", temporary, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      await this.git(["-C", temporary, "remote", "add", "origin", repoUrl]);
    }
    mkdirSync(join(this.deps.getHomeDir(userId)), { recursive: true });
    renameSync(temporary, workdir);
    return workdir;
  }

  /** 镜像自建 pack → packs/<slug>/ + manifest.json；返回数量供提交信息 */
  private async mirrorPacks(
    userId: string,
    workdir: string,
  ): Promise<{ packCount: number; skillCount: number }> {
    const packsDir = join(workdir, "packs");
    rmSync(packsDir, { recursive: true, force: true });
    mkdirSync(packsDir, { recursive: true });

    const packs = (await this.deps.packStore.listPacks(userId)).filter(isSyncablePack);
    const manifestPacks: Array<Record<string, unknown>> = [];
    let skillCount = 0;
    for (const pack of packs) {
      const packDir = this.resolvePackDir(userId, pack);
      const skills = await this.deps.packStore.listSkills(userId, pack.id);
      const metaSkills: Array<Record<string, unknown>> = [];
      for (const skill of skills) {
        const docPath = resolve(packDir, skill.relativePath);
        if (!isInside(docPath, packDir) || !existsSync(docPath)) continue;
        const target = join(packsDir, pack.slug, "skills", skill.name, "SKILL.md");
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, readFileSync(docPath, "utf8"));
        metaSkills.push({
          name: skill.name,
          description: skill.description,
          enabled: skill.enabled,
          allowedTools: skill.allowedTools ?? null,
          relativePath: `skills/${skill.name}/SKILL.md`,
        });
        skillCount += 1;
      }
      writeFileSync(
        join(packsDir, pack.slug, ".meta.json"),
        JSON.stringify(
          {
            slug: pack.slug,
            name: pack.name,
            description: pack.description ?? "",
            version: pack.version ?? "",
            enabled: pack.enabled,
            updatedAt: pack.updatedAt,
            skills: metaSkills,
          },
          null,
          2,
        ),
      );
      manifestPacks.push({
        slug: pack.slug,
        name: pack.name,
        enabled: pack.enabled,
        skills: metaSkills.map((s) => ({ name: s.name, enabled: s.enabled })),
      });
    }
    writeFileSync(
      join(workdir, "manifest.json"),
      // 不含生成时间戳：内容无变化时 diff 为空，避免每次同步产生空提交
      JSON.stringify({ source: "donger-skills", packs: manifestPacks }, null, 2),
    );
    return { packCount: packs.length, skillCount };
  }

  private async pushWithRetry(
    workdir: string,
    branch: string,
    credential: GitProcessCredential,
  ): Promise<void> {
    const push = () =>
      this.git(
        ["-C", workdir, "push", "--no-verify", "origin", `HEAD:refs/heads/${branch}`],
        credential,
      );
    let r = await push();
    if (r.code === 0) return;
    // 远端有新提交：先 rebase 再重试一次（串行队列已避免本机竞争，这里只处理远端漂移）
    await this.git(
      ["-C", workdir, "pull", "--rebase", "--autostash", "origin", branch],
      credential,
    );
    r = await push();
    if (r.code !== 0) {
      throw new Error(`推送失败：${sanitizeGitError(r.stderr || r.stdout || "未知错误")}`);
    }
  }

  private async resolveCredential(
    userId: string,
    code: string,
    repoUrl: string,
  ): Promise<GitProcessCredential | undefined> {
    if (!this.deps.credentialSets) return undefined;
    const [filled] = await this.deps.credentialSets.getFilledValues(userId, [code]);
    const pat = gitPatFromValues(filled?.values);
    if (!pat) return undefined;
    return { username: pat.user ?? defaultUsernameForHost(repoUrl), accessToken: pat.accessToken };
  }

  private async recordStatus(
    userId: string,
    status: "ok" | "failed" | "skipped",
    error?: string,
  ): Promise<void> {
    try {
      await this.deps.repoStore.setSyncStatus(userId, {
        at: new Date().toISOString(),
        status,
        ...(error ? { error: error.slice(0, ERROR_CLIP) } : {}),
      });
    } catch (e) {
      console.error("[skill-repo-sync] 记录同步状态失败:", (e as Error).message);
    }
  }

  /** 与 local-skill-installer 同规：builtin/绝对路径原样；相对路径相对用户 home */
  private resolvePackDir(userId: string, pack: SkillPack): string {
    return pack.builtin || isAbsolute(pack.installedPath)
      ? pack.installedPath
      : join(this.deps.getHomeDir(userId), pack.installedPath);
  }
}

/** 仅同步用户自建 pack：paste/upload 源；git 导入（上游已有历史）与 builtin（只读）不同步 */
function isSyncablePack(pack: SkillPack): boolean {
  return !pack.builtin && (pack.source.kind === "paste" || pack.source.kind === "upload");
}

function credentialMissingHint(code: string): string {
  return `凭证 ${code} 未配置 access_token，请在「我的凭证」填写后再同步`;
}

/** host → 平台默认 HTTP 认证用户名（与 git-access-gate.defaultGitUsername 对齐） */
function defaultUsernameForHost(repoUrl: string): string {
  try {
    const host = new URL(repoUrl).hostname;
    if (host === "github.com") return "x-access-token";
    if (host.endsWith("gitee.com")) return "x-token";
  } catch {
    // 非法 URL 落通用缺省
  }
  return "oauth2";
}

function isInside(child: string, parent: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}
