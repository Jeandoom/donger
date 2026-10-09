// 用户技能仓库 API：配置 CRUD + 连通性测试 + 手动同步。
// 路由登记在 web-route-guards（/api/skills/repo*），鉴权 authenticated，数据按 userId 隔离。

import { z } from "zod";
import {
  cleanHttpsRepoUrl,
  toUserSkillRepoView,
  UserSkillRepoInputSchema,
} from "../domain/user-skill-repo.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { UserSkillRepoStore } from "../ports/user-skill-repo-store.js";
import { SkillInstallError } from "../util/errors.js";
import type { SkillRepoSyncOutcome } from "./skill-repo-sync.js";

export interface SkillRepoApiDeps {
  repoStore: UserSkillRepoStore;
  /** 配置校验（模板存在性 + kind=git）；缺省时保存放行、同步时才报凭证缺失 */
  credentialSets?: CredentialSetStore;
  sync: {
    verify(
      user: { id: string },
      target?: { repoUrl: string; credentialCode: string },
    ): Promise<SkillRepoSyncOutcome>;
    syncNow(userId: string): Promise<SkillRepoSyncOutcome>;
    forget(userId: string): Promise<void>;
  };
  /** 回装（specs/2026-10-09-skills-git-hosting-design.md §3.2）：仓库 → git 源 pack；缺省=回装不可用 */
  packStore?: SkillPackStore;
  installer?: SkillInstaller;
}

export interface ApiResult {
  status: number;
  json: unknown;
}

const VerifyBodySchema = z.object({
  repoUrl: z.string().optional(),
  credentialCode: z.string().optional(),
});

export async function handleGetSkillRepo(
  userId: string,
  _body: unknown,
  d: SkillRepoApiDeps,
): Promise<ApiResult> {
  const cfg = await d.repoStore.get(userId);
  return { status: 200, json: { repo: cfg ? toUserSkillRepoView(cfg) : null } };
}

export async function handlePutSkillRepo(
  userId: string,
  body: unknown,
  d: SkillRepoApiDeps,
): Promise<ApiResult> {
  const b = (body ?? {}) as { repoUrl?: unknown };
  // repoUrl 为空 = 解绑：清理工作副本 + 删配置
  if (typeof b.repoUrl !== "string" || !b.repoUrl.trim()) {
    await d.sync.forget(userId);
    return { status: 200, json: { repo: null } };
  }
  const parsed = UserSkillRepoInputSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, json: { error: parsed.error.issues[0]?.message ?? "入参非法" } };
  }
  if (d.credentialSets) {
    const template = await d.credentialSets.getTemplate(parsed.data.credentialCode);
    if (!template) {
      return { status: 400, json: { error: `凭证模板不存在: ${parsed.data.credentialCode}` } };
    }
    if (template.kind !== "git") {
      return { status: 400, json: { error: "技能仓库须绑定 kind=git 的凭证模板（PAT）" } };
    }
  }
  await d.repoStore.upsert(userId, parsed.data);
  const cfg = await d.repoStore.get(userId);
  return { status: 200, json: { repo: cfg ? toUserSkillRepoView(cfg) : null } };
}

export async function handleVerifySkillRepo(
  userId: string,
  body: unknown,
  d: SkillRepoApiDeps,
): Promise<ApiResult> {
  const parsed = VerifyBodySchema.safeParse(body ?? {});
  const target =
    parsed.success && parsed.data.repoUrl && parsed.data.credentialCode
      ? { repoUrl: parsed.data.repoUrl, credentialCode: parsed.data.credentialCode }
      : undefined;
  // verify 的 repoUrl 直接进 git ls-remote：不做 https-only 校验 = ext::/ssh:// 等任意
  // 传输协议可达（ext:: 形态 git 会把 URL 余下内容当本机命令执行）。与保存通道同规。
  if (target && !cleanHttpsRepoUrl(target.repoUrl)) {
    return { status: 400, json: { ok: false, message: "repoUrl 必须为无凭证内嵌的 HTTPS 地址" } };
  }
  const outcome = await d.sync.verify({ id: userId }, target);
  return { status: 200, json: outcome };
}

export async function handleSyncSkillRepo(
  userId: string,
  _body: unknown,
  d: SkillRepoApiDeps,
): Promise<ApiResult> {
  const outcome = await d.sync.syncNow(userId);
  const cfg = await d.repoStore.get(userId);
  return {
    status: 200,
    json: { ...outcome, repo: cfg ? toUserSkillRepoView(cfg) : null },
  };
}

const RepoInstallBodySchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "slug 须为小写字母/数字/连字符"),
  replace: z.boolean().optional(),
});

/**
 * 回装（push 镜像的反向）：从个人技能仓库按 packs/<slug> 以 git 源安装。
 * 语义=仅补缺 + 显式替换（拍板 D3）：本地同 slug 存在时默认 409，replace=true 且
 * 本地为 paste/upload 源才先卸载再装（git/builtin 源有上游管理，拒绝覆盖）。
 */
export async function handleRepoInstall(
  userId: string,
  body: unknown,
  d: SkillRepoApiDeps,
): Promise<ApiResult> {
  if (!d.packStore || !d.installer) {
    return { status: 500, json: { error: "回装通道未装配（缺 packStore/installer）" } };
  }
  const parsed = RepoInstallBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return { status: 400, json: { error: parsed.error.issues[0]?.message ?? "入参非法" } };
  }
  const { slug, replace } = parsed.data;
  const cfg = await d.repoStore.get(userId);
  if (!cfg) return { status: 400, json: { error: "未配置技能仓库" } };

  const existing = await d.packStore.getPackBySlug(userId, slug);
  if (existing && replace !== true) {
    return {
      status: 409,
      json: {
        error: `本地已存在同名技能包「${slug}」；确认替换请携带 replace=true`,
        code: "PACK_EXISTS",
      },
    };
  }
  try {
    if (existing) {
      if (existing.builtin || existing.source.kind === "git") {
        return {
          status: 400,
          json: { error: `「${slug}」由 ${existing.builtin ? "内置" : "git 上游"}管理，不可替换` },
        };
      }
      await d.installer.uninstall(userId, existing.id);
    }
    const pack = await d.installer.installFromGit(userId, {
      url: cfg.repoUrl,
      ref: cfg.branch,
      subPath: `packs/${slug}`,
      credentialCode: cfg.credentialCode,
      slug,
    });
    const skills = await d.packStore.listSkills(userId, pack.id);
    return {
      status: 200,
      json: {
        ok: true,
        replaced: Boolean(existing),
        pack: { ...pack, skills },
      },
    };
  } catch (e) {
    return {
      status: 400,
      json: {
        error: (e as Error).message,
        code: e instanceof SkillInstallError ? e.code : undefined,
      },
    };
  }
}
