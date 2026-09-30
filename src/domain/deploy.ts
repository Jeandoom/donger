// 部署运维闭环域模型（spec docs/superpowers/specs/2026-09-30-deploy-ops-loop-design.md）。
//
// 安全基线：字段值（workdir/branch/service/ref/host/username）以 regex 收口元字符，
// 因为这些值会经模板渲染进 SSH 命令串（目标机 shell 解析）——白名单字符集是
// 命令注入的第一道防线；剧本命令本身由 owner/admin 显式配置（等价于其既有 SSH 权限），
// 仅约束单行与长度。

import { z } from "zod";
import { CREDENTIAL_CODE_PATTERN } from "./credential.js";
import { GitProviderSchema, parseRepositoryUrl } from "./git.js";

/** 服务标识：命令模板 {service} 变量（字母数字-_） */
export const SERVICE_ID_PATTERN = /^[\w-]{1,64}$/;
/** 分支/tag/ref 名（git check-ref-format 收口：无空格、不以 / 开头、无连续 ..） */
export const REF_PATTERN = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[\w.\-/]{1,120}$/;
/** 目标机 hostname（无 scheme、无路径） */
export const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,189}$/;
/** 目标机用户名 */
export const SSH_USER_PATTERN = /^[\w.@-]{1,64}$/;
/** 目标机绝对路径（unix 形态；无空格/引号/分号等元字符——模板安全边界） */
export const REMOTE_PATH_PATTERN = /^\/[\w.\-/]{0,240}$/;
/** 远程日志文件路径（tail/clean 的入参，同 REMOTE_PATH 收口） */
export const REMOTE_LOG_FILE_PATTERN = REMOTE_PATH_PATTERN;
/** commit sha（完整 40 位或短 sha） */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
/** 剧本命令：单行、非空、上限 500 字（多行命令由数组表达，逐条执行） */
const COMMAND_SCHEMA = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !/[\r\n]/.test(v), "命令必须为单行（多步用数组表达）");

const SshEndpointSchema = z.object({
  host: z.string().regex(SSH_HOST_PATTERN, "host 须为裸 hostname"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().regex(SSH_USER_PATTERN, "username 含非法字符"),
  /** 凭证体系 generic 模板 code（键 private_key / password，至少其一） */
  credentialCode: z.string().regex(CREDENTIAL_CODE_PATTERN),
});

export const DeployTargetSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().trim().min(1).max(50),
  service: z.string().regex(SERVICE_ID_PATTERN, "service 仅允许字母数字-_"),
  provider: GitProviderSchema,
  repoUrl: z
    .string()
    .refine((v) => parseRepositoryUrl(v) !== undefined, "repoUrl 须为无凭证内嵌的 HTTPS 地址"),
  branch: z.string().regex(REF_PATTERN, "branch 名不合法"),
  /** git PAT 凭证模板 code（轮询平台 API 用；公共仓库可留空） */
  gitCredentialCode: z.string().regex(CREDENTIAL_CODE_PATTERN).optional(),
  ssh: SshEndpointSchema,
  workdir: z.string().regex(REMOTE_PATH_PATTERN, "workdir 须为无元字符的绝对路径"),
  /** 部署剧本：逐条顺序执行，任一非零退出即失败（模板变量 {ref}/{branch}/{workdir}/{service}） */
  prepareCommands: z.array(COMMAND_SCHEMA).min(1).max(10),
  /** 重启剧本（service_restart 工具用；空=该目标不支持重启动作） */
  restartCommands: z.array(COMMAND_SCHEMA).max(10).default([]),
  /** 部署后健康检查：cmd 退出码 0 即健康；expectContains 额外校验输出包含 */
  healthCheck: z
    .object({
      cmd: COMMAND_SCHEMA,
      expectContains: z.string().min(1).max(200).optional(),
    })
    .optional(),
  /** 轮询发现新提交即自动执行（测试环境 true / 生产环境 false=仅通知） */
  autoDeploy: z.boolean().default(false),
  enabled: z.boolean().default(false),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type DeployTarget = z.infer<typeof DeployTargetSchema>;

export const DeployTargetInputSchema = DeployTargetSchema.omit({
  id: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
});
export type DeployTargetInput = z.input<typeof DeployTargetInputSchema>;

export const DeployStepSchema = z.object({
  name: z.string().min(1).max(50),
  command: COMMAND_SCHEMA,
  exitCode: z.number().int(),
  durationMs: z.number().int().min(0),
  /** 步骤输出尾部（截断落库，防单轮 token 爆炸与库膨胀） */
  outputTail: z.string().max(4000).default(""),
});
export type DeployStep = z.infer<typeof DeployStepSchema>;

export const DeployOrderStatusSchema = z.enum(["running", "success", "failed"]);
export type DeployOrderStatus = z.infer<typeof DeployOrderStatusSchema>;

export const DeployTriggerSchema = z.enum(["poll", "manual", "agent"]);
export type DeployTrigger = z.infer<typeof DeployTriggerSchema>;

export const DeployOrderSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  trigger: DeployTriggerSchema,
  /** 部署指向的 ref（sha/tag/branch）；手动触发未指定时执行期回填分支 HEAD */
  ref: z.string().regex(REF_PATTERN).optional(),
  sha: z.string().regex(COMMIT_SHA_PATTERN).optional(),
  status: DeployOrderStatusSchema,
  steps: z.array(DeployStepSchema).default([]),
  error: z.string().max(1000).optional(),
  startedAt: z.string().min(1),
  /** 未完成=null（DB 态）；终态填 ISO 时间 */
  finishedAt: z.string().min(1).nullish(),
});
export type DeployOrder = z.infer<typeof DeployOrderSchema>;

/** 剧本模板变量替换：仅接受白名单字符集的值（regex 收口在上层 schema），
 *  未提供 ref 的命令上下文回退分支名 */
export function renderDeployCommand(
  template: string,
  vars: { ref?: string; branch: string; workdir: string; service: string },
): string {
  const ref = vars.ref ?? vars.branch;
  return template
    .replaceAll("{ref}", ref)
    .replaceAll("{branch}", vars.branch)
    .replaceAll("{workdir}", vars.workdir)
    .replaceAll("{service}", vars.service);
}

/** 从平台 getBranch 原生 JSON 提取分支 HEAD sha（gitee/github=commit.sha / gitlab=commit.id） */
export function extractBranchHeadSha(provider: string, body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const commit = (payload as { commit?: unknown }).commit;
  if (typeof commit !== "object" || commit === null) return undefined;
  const sha =
    provider === "jihulab" ? (commit as { id?: unknown }).id : (commit as { sha?: unknown }).sha;
  return typeof sha === "string" && COMMIT_SHA_PATTERN.test(sha) ? sha : undefined;
}
