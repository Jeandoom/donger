// 技能页数据获取 + 纯函数。后端契约见 skill-api.ts。
import { apiFetch, apiFetchRetry } from "./auth";

export interface SkillCredentialSpecDTO {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
  configured?: boolean; // 仅 pack 视图里带
}

export interface PackSkillDTO {
  id: string;
  packId: string;
  name: string;
  description: string;
  allowedTools?: string[];
  relativePath: string;
  enabled: boolean;
}

export interface SkillPackDTO {
  id: string;
  slug: string;
  name: string;
  description?: string;
  version?: string;
  source: {
    kind: "git" | "upload" | "paste" | "builtin";
    url?: string;
    subPath?: string;
    originalFilename?: string;
  };
  installedPath: string;
  enabled: boolean;
  builtin: boolean;
  // pack 声明式凭证体系已退役，后端可能不再返回该字段
  credentials?: SkillCredentialSpecDTO[];
  skills: PackSkillDTO[];
}

export interface CredentialKeySpecDTO {
  key: string;
  label?: string;
}

export interface CredentialTemplateDTO {
  code: string;
  name: string;
  description?: string;
  /** 用途：generic=注入环境变量；git=git PAT 专用（不注入 env，仅 donger-git 工具现取） */
  kind?: "generic" | "git" | "host";
  /** kind=git 时的目标仓库声明（一凭一仓）；缺省 = 平台级凭证 */
  repoUrl?: string;
  keySpecs: CredentialKeySpecDTO[];
  createdBy: string;
  updatedAt: string;
}

export interface CredentialValueViewDTO {
  code: string;
  /** 展示名：用户别名优先，缺省回退模板名 */
  name: string;
  /** 用户自定显示名（未设置时 undefined） */
  alias?: string;
  description?: string;
  kind?: "generic" | "git" | "host";
  keySpecs: CredentialKeySpecDTO[];
  filledKeys: string[];
  missingKeys: string[];
  updatedAt: string;
}

/** 模糊查询全局凭证模板（code/名称/描述） */
export async function fetchCredentialTemplates(q?: string): Promise<CredentialTemplateDTO[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const res = await apiFetchRetry(`/api/credential-templates${qs}`);
  if (!res.ok) throw new Error(`list templates ${res.status}`);
  const data = (await res.json()) as { templates: CredentialTemplateDTO[] };
  return data.templates;
}

export async function createCredentialTemplate(input: {
  code: string;
  name: string;
  description?: string;
  kind?: "generic" | "git" | "host";
  repoUrl?: string;
  keySpecs: CredentialKeySpecDTO[];
}): Promise<void> {
  const res = await apiFetch("/api/credential-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `create template ${res.status}`);
}

export async function updateCredentialTemplate(
  code: string,
  input: {
    name: string;
    description?: string;
    kind?: "generic" | "git" | "host";
    repoUrl?: string;
    keySpecs: CredentialKeySpecDTO[];
  },
): Promise<void> {
  const res = await apiFetch(`/api/credential-templates/${encodeURIComponent(code)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    // 后端 CredentialTemplateInputSchema 必填 code（含格式校验），需随体回传
    body: JSON.stringify({ code, ...input }),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `update template ${res.status}`);
}

/** 删除模板；被引用时后端 409，抛错文案含引用数 */
export async function deleteCredentialTemplate(code: string): Promise<void> {
  const res = await apiFetch(`/api/credential-templates/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `delete template ${res.status}`);
}

/** 我的凭证（键名视图，值永不回显） */
export async function fetchMyCredentials(): Promise<CredentialValueViewDTO[]> {
  const res = await apiFetchRetry("/api/credential-values");
  if (!res.ok) throw new Error(`list credentials ${res.status}`);
  const data = (await res.json()) as { credentials: CredentialValueViewDTO[] };
  return data.credentials;
}

/** 填写凭证值（合并语义：新值覆盖同键，未提及的既有键保留） */
export async function upsertCredentialValue(
  code: string,
  values: Record<string, string>,
): Promise<void> {
  const res = await apiFetch(`/api/credential-values/${encodeURIComponent(code)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `set credential ${res.status}`);
}

export async function deleteCredentialValue(code: string): Promise<void> {
  const res = await apiFetch(`/api/credential-values/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete credential ${res.status}`);
}

/** 改本人凭证显示名（别名）；只改名称，不触碰加密 values */
export async function renameCredentialValue(code: string, name: string): Promise<void> {
  const res = await apiFetch(`/api/credential-values/${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `rename credential ${res.status}`);
}

export async function fetchPacks(): Promise<SkillPackDTO[]> {
  const res = await apiFetch("/api/skills/packs");
  if (!res.ok) throw new Error(`list packs ${res.status}`);
  const data = (await res.json()) as { packs: SkillPackDTO[] };
  return data.packs;
}

export async function installPack(source: unknown): Promise<SkillPackDTO> {
  const res = await apiFetch("/api/skills/packs/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `install ${res.status}`);
  return (await res.json()).pack as SkillPackDTO;
}

export async function installUpload(filename: string, content: string): Promise<SkillPackDTO> {
  const res = await apiFetch("/api/skills/packs/install/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content }),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `upload ${res.status}`);
  return (await res.json()).pack as SkillPackDTO;
}

export async function setPackEnabled(id: string, enabled: boolean): Promise<void> {
  await apiFetch(`/api/skills/packs/${enabled ? "enable" : "disable"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  await apiFetch(`/api/skills/skills/${enabled ? "enable" : "disable"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function uninstallPack(id: string): Promise<void> {
  await apiFetch("/api/skills/packs/uninstall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function updatePack(id: string): Promise<void> {
  await apiFetch("/api/skills/packs/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

// ---- 安装/更新任务化（2026-10 体验轮）：提交即返 jobId，轮询阶段/可取消 ----

export type SkillJobOp = "install-git" | "install-upload" | "install-paste" | "update";

export interface SkillJobView {
  id: string;
  kind: SkillJobOp;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** 人读阶段文案（如「正在克隆仓库…」） */
  stage: string;
  error?: string;
  /** 后端 SkillInstallError.code（GIT_CLONE_FAILED / CREDENTIAL_TOKEN_MISSING / CANCELLED…） */
  errorCode?: string;
  packId?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export async function startSkillJob(req: {
  op: SkillJobOp;
  source?: unknown;
  id?: string;
  filename?: string;
  content?: string;
}): Promise<{ jobId: string }> {
  const res = await apiFetch("/api/skills/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `start job ${res.status}`);
  return (await res.json()) as { jobId: string };
}

export async function fetchSkillJob(jobId: string): Promise<SkillJobView> {
  const res = await apiFetch(`/api/skills/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`job ${res.status}`);
  return (await res.json()) as SkillJobView;
}

export async function cancelSkillJob(jobId: string): Promise<void> {
  const res = await apiFetch(`/api/skills/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  if (!res.ok && res.status !== 404) throw new Error(`cancel ${res.status}`);
}

/** 轮询直至任务终结（done/failed/cancelled）；onTick 每次快照回调，用于展示阶段 */
export async function waitSkillJob(
  jobId: string,
  onTick?: (job: SkillJobView) => void,
  intervalMs = 1000,
): Promise<SkillJobView> {
  for (;;) {
    const job = await fetchSkillJob(jobId);
    onTick?.(job);
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---- 卸载影响面 + SKILL.md 预览（2026-10 体验轮）----

export interface PackUsageDTO {
  packId: string;
  agents: Array<{ id: string; name: string }>;
}

export async function fetchPackUsage(packId: string): Promise<PackUsageDTO> {
  const res = await apiFetch(`/api/skills/packs/${encodeURIComponent(packId)}/usage`);
  if (!res.ok) throw new Error(`usage ${res.status}`);
  return (await res.json()) as PackUsageDTO;
}

export async function fetchSkillDoc(packId: string, skillName: string): Promise<string> {
  const res = await apiFetch(
    `/api/skills/packs/${encodeURIComponent(packId)}/skills/${encodeURIComponent(skillName)}/doc`,
  );
  if (!res.ok) throw new Error(`doc ${res.status}`);
  const body = (await res.json()) as { content: string };
  return body.content;
}

// ---- 用户技能仓库（自建技能 git 镜像同步）----

export interface SkillRepoConfigDTO {
  repoUrl: string;
  credentialCode: string;
  branch: string;
  enabled: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: "ok" | "failed" | "skipped";
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRepoProbeResult {
  ok: boolean;
  message: string;
}

export async function fetchSkillRepo(): Promise<SkillRepoConfigDTO | null> {
  const res = await apiFetchRetry("/api/skills/repo");
  if (!res.ok) throw new Error(`load skill repo ${res.status}`);
  const data = (await res.json()) as { repo: SkillRepoConfigDTO | null };
  return data.repo;
}

/** 保存配置；repoUrl 传空串 = 解绑 */
export async function saveSkillRepo(input: {
  repoUrl: string;
  credentialCode: string;
  branch?: string;
}): Promise<SkillRepoConfigDTO | null> {
  const res = await apiFetch("/api/skills/repo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `save skill repo ${res.status}`);
  const data = (await res.json()) as { repo: SkillRepoConfigDTO | null };
  return data.repo;
}

export async function verifySkillRepo(input?: {
  repoUrl: string;
  credentialCode: string;
}): Promise<SkillRepoProbeResult> {
  const res = await apiFetch("/api/skills/repo/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `verify skill repo ${res.status}`);
  return (await res.json()) as SkillRepoProbeResult;
}

export async function syncSkillRepo(): Promise<SkillRepoProbeResult> {
  const res = await apiFetch("/api/skills/repo/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error((await safeErr(res)) ?? `sync skill repo ${res.status}`);
  return (await res.json()) as SkillRepoProbeResult;
}

async function safeErr(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error;
  } catch {
    return undefined;
  }
}

/** 凭证状态：区分已配置 / 缺失（用于徽章展示）。 */
export function credentialStatus(pack: {
  // pack 声明式凭证体系已退役，后端 DTO 可能不再返回该字段
  credentials?: SkillCredentialSpecDTO[] | null;
}): {
  configured: string[];
  missing: string[];
} {
  const configured: string[] = [];
  const missing: string[] = [];
  for (const c of pack.credentials ?? []) {
    (c.configured ? configured : missing).push(c.key);
  }
  return { configured, missing };
}

// ---- 全量清单 / agent 级落点 / 提升托管 / 回装（specs/2026-10-09-skills-git-hosting-design.md）----

export interface SkillInventoryRecordDTO {
  id: string;
  origin: "pack" | "agent";
  packSource?: string;
  name: string;
  description: string;
  enabled: boolean;
  packId?: string;
  packSlug?: string;
  agentId?: string;
  agentName?: string;
  hosted: boolean;
  updatedAt?: string;
}

export interface SkillInventoryDTO {
  records: SkillInventoryRecordDTO[];
  repo: { configured: boolean; hostedSlugs: string[] };
}

export async function fetchSkillInventory(): Promise<SkillInventoryDTO> {
  const res = await apiFetch("/api/skills/inventory");
  if (!res.ok) throw new Error(`inventory ${res.status}`);
  return (await res.json()) as SkillInventoryDTO;
}

export async function installSkillToAgent(body: {
  agentId: string;
  from: { kind: "pack"; packId: string; skill: string } | { kind: "content"; content: string };
  overwrite?: boolean;
}): Promise<{ installed: { agentId: string; name: string; id: string } }> {
  const res = await apiFetch("/api/skills/agent-install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok)
    throw Object.assign(new Error(String(data.error ?? `install ${res.status}`)), {
      code: data.code,
    });
  return data as never;
}

export async function hostSkill(
  agentId: string,
  skill: string,
): Promise<{ action: string; packSlug: string }> {
  const res = await apiFetch("/api/skills/host", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, skill }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `host ${res.status}`));
  return data as never;
}

export async function repoInstallSkill(
  slug: string,
  replace?: boolean,
): Promise<{ replaced: boolean }> {
  const res = await apiFetch("/api/skills/repo/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, replace }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok)
    throw Object.assign(new Error(String(data.error ?? `repo install ${res.status}`)), {
      code: data.code,
    });
  return data as never;
}
