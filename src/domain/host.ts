// 主机资产域模型（spec 2026-09-30-deploy-ops-loop-design §6 v2）：
// SSH 端点 + 凭证引用的一等资产——像凭证/连接器一样登记一次、处处引用（donger-host
// 工具/未来 landside）。纯端点，不携带任何部署逻辑（部署知识在仓库与技能里）。

import { z } from "zod";
import { CREDENTIAL_CODE_PATTERN } from "./credential.js";

/** 目标机 hostname（无 scheme/路径） */
export const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,189}$/;
/** SSH 用户名 */
export const SSH_USER_PATTERN = /^[\w.@-]{1,64}$/;
/** 目标机绝对路径（诊断类工具入参的元字符收口） */
export const REMOTE_PATH_PATTERN = /^\/[\w.\-/]{0,240}$/;

export const HostSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().trim().min(1).max(50),
  host: z.string().regex(HOST_NAME_PATTERN, "host 须为裸 hostname"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().regex(SSH_USER_PATTERN, "username 含非法字符"),
  /** 凭证体系 generic 模板 code（键 private_key / password，至少其一） */
  credentialCode: z.string().regex(CREDENTIAL_CODE_PATTERN),
  description: z.string().max(200).optional(),
  /** 停用后：会话不挂载（其属主仍可经其他主机满足挂载条件）、工具调用拒绝 */
  enabled: z.boolean().default(true),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Host = z.infer<typeof HostSchema>;

export const HostInputSchema = HostSchema.omit({
  id: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
});
export type HostInput = z.input<typeof HostInputSchema>;
