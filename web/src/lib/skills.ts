// 技能页数据获取 + 纯函数。后端契约见 skill-api.ts。
import { apiFetch } from "./auth";

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
  kind?: "generic" | "git";
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
  kind?: "generic" | "git";
  keySpecs: CredentialKeySpecDTO[];
  filledKeys: string[];
  missingKeys: string[];
  updatedAt: string;
}

/** 模糊查询全局凭证模板（code/名称/描述） */
export async function fetchCredentialTemplates(q?: string): Promise<CredentialTemplateDTO[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const res = await apiFetch(`/api/credential-templates${qs}`);
  if (!res.ok) throw new Error(`list templates ${res.status}`);
  const data = (await res.json()) as { templates: CredentialTemplateDTO[] };
  return data.templates;
}

export async function createCredentialTemplate(input: {
  code: string;
  name: string;
  description?: string;
  kind?: "generic" | "git";
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
    kind?: "generic" | "git";
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
  const res = await apiFetch("/api/credential-values");
  if (!res.ok) throw new Error(`list credentials ${res.status}`);
  const data = (await res.json()) as { credentials: CredentialValueViewDTO[] };
  return data.credentials;
}

/** 填写/覆写凭证值（整体覆写） */
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
