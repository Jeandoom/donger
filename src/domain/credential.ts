// 凭证集领域类型（纯数据）。模板=结构元数据（全局一份，code 全局唯一）；用户值=敏感负载（按用户隔离）。
// 模板管理权归创建人；用户值仅本人可见、任何接口不回显。

import { z } from "zod";

/** code 规范：小写字母/数字开头，小写字母数字--_，供环境变量命名空间映射 */
export const CREDENTIAL_CODE_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export const CredentialKeySpecSchema = z.object({
  /** 键名（凭证信息结构里的 k），如 token；注入时映射为 <CODE>_<KEY> 环境变量 */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "键名仅允许字母数字下划线"),
  /** 表单渲染用的人读说明（不参与注入） */
  label: z.string().max(100).optional(),
});
export type CredentialKeySpec = z.infer<typeof CredentialKeySpecSchema>;

/** 全局凭证模板：结构元数据，不含任何值 */
export const CredentialTemplateSchema = z.object({
  code: z.string().regex(CREDENTIAL_CODE_PATTERN),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  keySpecs: z.array(CredentialKeySpecSchema).min(1).max(32),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CredentialTemplate = z.infer<typeof CredentialTemplateSchema>;

/** 模板入参（创建/编辑；createdBy 由服务端注入） */
export const CredentialTemplateInputSchema = CredentialTemplateSchema.omit({
  createdBy: true,
  createdAt: true,
  updatedAt: true,
});
export type CredentialTemplateInput = z.infer<typeof CredentialTemplateInputSchema>;

/** 用户凭证值：引用模板 code，负载整体加密存储；任何 API 不回显 */
export interface CredentialValueEntry {
  userId: string;
  code: string;
  /** 已解密负载；仅在注入/内部链路出现，REST 永不返回 */
  values: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** 用户凭证值入参（PUT；整体覆写） */
export const CredentialValueInputSchema = z.object({
  values: z
    .record(z.string(), z.string().min(1))
    .refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 32, {
      message: "values 需包含 1-32 个键值对",
    }),
});
export type CredentialValueInput = z.infer<typeof CredentialValueInputSchema>;

/** 用户凭证视图（列表/详情展示用；仅键名，无值） */
export interface CredentialValueView {
  code: string;
  name: string;
  description?: string;
  keySpecs: CredentialKeySpec[];
  /** 模板 keySpecs 中用户已填写/未填写的键名（部分填写提示用） */
  filledKeys: string[];
  missingKeys: string[];
  updatedAt: string;
}

export function parseCredentialCode(raw: unknown): string {
  const code = z.string().parse(raw);
  if (!CREDENTIAL_CODE_PATTERN.test(code)) {
    throw new Error(`凭证 code 非法: ${code}（需匹配 ${CREDENTIAL_CODE_PATTERN.source}）`);
  }
  return code;
}
