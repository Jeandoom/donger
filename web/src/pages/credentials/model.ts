import type {
  CredentialKeySpecDTO,
  CredentialTemplateDTO,
  CredentialValueViewDTO,
} from "../../lib/skills";

/** 列表行：我的值条目与全局模板按 code 合并后的展示视图 */
export interface CredentialRow {
  code: string;
  /** 展示名：个人别名优先，回退模板名 */
  name: string;
  alias?: string;
  description?: string;
  kind: "generic" | "git";
  keySpecs: CredentialKeySpecDTO[];
  filledKeys: string[];
  missingKeys: string[];
  repoUrl?: string;
  createdBy?: string;
  /** 仅有全局模板、本人尚未填写任何值 */
  templateOnly: boolean;
  /** 值条目存在但模板已被删除 */
  orphan: boolean;
  updatedAt: string;
}

/**
 * 合并「我的凭证」与「全局模板」为单一列表（与 CredentialPicker 同一去重口径）。
 * 排序：待补全（含未配置）在前，其余按 code 字典序。
 */
export function mergeCredentialRows(
  mine: CredentialValueViewDTO[],
  templates: CredentialTemplateDTO[],
): CredentialRow[] {
  const byCode = new Map(templates.map((t) => [t.code, t]));
  const rows: CredentialRow[] = [];
  for (const c of mine) {
    const t = byCode.get(c.code);
    rows.push({
      code: c.code,
      name: c.name,
      alias: c.alias,
      description: t?.description ?? c.description,
      kind: t?.kind ?? c.kind ?? "generic",
      keySpecs: t?.keySpecs ?? c.keySpecs,
      filledKeys: c.filledKeys,
      missingKeys: t ? c.missingKeys : [],
      repoUrl: t?.repoUrl,
      createdBy: t?.createdBy,
      templateOnly: false,
      orphan: !t,
      updatedAt: c.updatedAt,
    });
    byCode.delete(c.code);
  }
  for (const t of byCode.values()) {
    rows.push({
      code: t.code,
      name: t.name,
      description: t.description,
      kind: t.kind ?? "generic",
      keySpecs: t.keySpecs,
      filledKeys: [],
      missingKeys: t.keySpecs.map((k) => k.key),
      repoUrl: t.repoUrl,
      createdBy: t.createdBy,
      templateOnly: true,
      orphan: false,
      updatedAt: t.updatedAt,
    });
  }
  return rows.sort((a, b) => todoRank(a) - todoRank(b) || a.code.localeCompare(b.code));
}

const todoRank = (r: CredentialRow) => (r.missingKeys.length > 0 ? 0 : 1);

export type CredentialFilter = "all" | "todo" | "ready";

/** 前端过滤：状态分段 + 关键词（code/名称/说明，大小写不敏感） */
export function filterCredentialRows(
  rows: CredentialRow[],
  filter: CredentialFilter,
  query: string,
): CredentialRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "todo" && r.missingKeys.length === 0) return false;
    if (filter === "ready" && r.missingKeys.length > 0) return false;
    if (!q) return true;
    return (
      r.code.includes(q) ||
      r.name.toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q)
    );
  });
}

/** 与服务端 CREDENTIAL_CODE_PATTERN 对齐：小写字母/数字开头，小写字母数字-_ */
export const CREDENTIAL_CODE_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** 与服务端 CredentialKeySpecSchema 对齐：1-64 位字母数字下划线 */
export const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export function validateCredentialCode(code: string): string | null {
  if (!code) return "请填写 code";
  if (!CREDENTIAL_CODE_PATTERN.test(code)) {
    return "code 需以小写字母或数字开头，仅含小写字母、数字、-、_（最长 64 位）";
  }
  return null;
}
