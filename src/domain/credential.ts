// 凭证集领域类型（纯数据）。模板=结构元数据（全局一份，code 全局唯一）；用户值=敏感负载（按用户隔离）。
// 模板管理权归创建人；用户值仅本人可见、任何接口不回显。

import { z } from "zod";

/** code 规范：小写字母/数字开头，小写字母数字--_，供环境变量命名空间映射 */
export const CREDENTIAL_CODE_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/**
 * 凭证用途：
 * - generic：注入 SDK env（<CODE>_<KEY>），供 agent 进程直接读取；
 * - git：git 平台 PAT 专用，不注入 env——token 仅经凭证桥在 donger-git 工具/
 *   仓库物化内现取，防止 agent 拿到 token 后绕过工具直连平台（规格
 *   2026-09-09-git-platform-tools-design.md 防线 1）。
 */
export const CredentialKindSchema = z.enum(["generic", "git"]).default("generic");
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

export const CredentialKeySpecSchema = z.object({
  /** 键名（凭证信息结构里的 k）；注入时映射为 <CODE>_<KEY> 环境变量 */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "键名仅允许字母数字下划线"),
  /** 表单渲染用的人读说明（不参与注入） */
  label: z.string().max(100).optional(),
});
export type CredentialKeySpec = z.infer<typeof CredentialKeySpecSchema>;

/**
 * git PAT 凭证的固定键名契约（读取与表单唯一来源，不允许自定义）：
 * - access_token：令牌主体（与 Gitee/GitLab 平台 API 参数名对齐）；
 * - user：可选 HTTP 认证用户名（留空走平台默认，见 defaultGitUsername）。
 * 凭证桥（donger-git 工具/仓库物化）只认这两个键；2026-09-17 前历史键为
 * token/username，存量值需重填或迁移。
 */
export const GIT_PAT_KEY_SPECS: CredentialKeySpec[] = [
  { key: "access_token", label: "访问令牌（PAT）" },
  { key: "user", label: "HTTP 认证用户名（可留空走平台默认）" },
];

/** 从已解密值按固定键提取 git PAT；缺 access_token 视为未填写 */
export function gitPatFromValues(
  values: Record<string, string> | undefined,
): { accessToken: string; user?: string } | undefined {
  const accessToken = values?.access_token;
  if (!accessToken) return undefined;
  return { accessToken, user: values?.user };
}

/** kind=git 模板键名收口：覆写为固定键（创建/编辑入参不允许自定义键名）；generic 原样 */
export function withGitPatKeySpecs<
  T extends { kind: CredentialKind; keySpecs: CredentialKeySpec[] },
>(input: T): T {
  return input.kind === "git" ? { ...input, keySpecs: GIT_PAT_KEY_SPECS } : input;
}

/** 全局凭证模板：结构元数据，不含任何值 */
export const CredentialTemplateSchema = z.object({
  code: z.string().regex(CREDENTIAL_CODE_PATTERN),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  kind: CredentialKindSchema,
  /**
   * kind=git 时的目标仓库声明（一凭一仓，spec 2026-09-10 §3.1）；缺省 = 平台级凭证
   * （兼容存量宽松语义）。必须为无凭证内嵌的 HTTPS 地址。
   */
  repoUrl: z
    .string()
    .url()
    .optional()
    .refine((url) => {
      if (!url) return true;
      try {
        const parsed = new URL(url);
        return (
          parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash
        );
      } catch {
        return false;
      }
    }, "repoUrl 必须为无凭证内嵌的 HTTPS 地址"),
  keySpecs: z.array(CredentialKeySpecSchema).min(1).max(32),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CredentialTemplate = z.infer<typeof CredentialTemplateSchema>;

/** 模板入参（创建/编辑；createdBy 由服务端注入）。用 z.input：kind 等带 default 的字段入参可省略 */
export const CredentialTemplateInputSchema = CredentialTemplateSchema.omit({
  createdBy: true,
  createdAt: true,
  updatedAt: true,
});
export type CredentialTemplateInput = z.input<typeof CredentialTemplateInputSchema>;

/** 用户凭证值：引用模板 code，负载整体加密存储；任何 API 不回显 */
export interface CredentialValueEntry {
  userId: string;
  code: string;
  /** 用户自定显示名（个人别名；缺省展示回退模板名） */
  name?: string;
  /** 已解密负载；仅在注入/内部链路出现，REST 永不返回 */
  values: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** 凭证项改名入参（仅改本人显示名，不触碰加密 values） */
export const CredentialRenameInputSchema = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(100, "名称最长 100 字"),
});
export type CredentialRenameInput = z.infer<typeof CredentialRenameInputSchema>;

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
  /** 展示名：用户别名优先，缺省回退模板名 */
  name: string;
  /** 用户自定显示名（未设置时 undefined，展示名即模板名） */
  alias?: string;
  description?: string;
  kind: CredentialKind;
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
