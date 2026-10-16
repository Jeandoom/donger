/**
 * 自动发布策略引擎（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.3）。
 * 纯函数 + 可全量单测：判定偏保守——误放行=绕过 force 门的事故，误拦截=回人工审批。
 * 输入只信真实 diff（平台 API 拉取），不信 agent 提案声明。
 * 红线路径/限额首版值=spec D5 推荐值，admin 可在 workflow.autoDev.policy 覆盖。
 */
import { z } from "zod";

/**
 * 红线路径（正则 source，对 git 路径——恒 / 分隔——做 match）。
 * 覆盖：安全边界与门 / 引擎 runner / 部署与宿主 / 凭证与身份 / 依赖清单 / L2 自身机制。
 * 命中任一即整体拒绝自动合并（转人工），reasons 列出命中文件。
 */
export const DEFAULT_PROTECTED_PATH_SOURCES = [
  // 安全边界与门（进化官红线同源 + 审批/权限语义）
  "^src/orchestrator/default-gates\\.ts$",
  "^src/domain/gate-router\\.ts$",
  "^src/orchestrator/approval-flow\\.ts$",
  "^src/domain/permission-mode\\.ts$",
  "^src/adapters/web-route-guards\\.ts$",
  // 引擎 runner（三引擎全部）
  "^src/adapters/[\\w.-]*agent-runner\\.ts$",
  "^src/adapters/codex-chat-bridge\\.ts$",
  // 部署与宿主
  "^deploy/",
  "^scripts/(docker|host)-",
  "^\\.env",
  "(^|/)Dockerfile(\\.[\\w.-]+)?$",
  // 凭证与身份 + git 领域（凭证解析/仓库绑定语义）
  "^src/adapters/credential",
  "^src/domain/git\\.ts$",
  "^migrations/",
  // 依赖清单（自动链禁止新增/升级依赖；lock 二并覆盖）
  "^package\\.json$",
  "^package-lock\\.json$",
  // L2 自身机制（改发布策略=自我提权，恒人工）
  "^src/domain/release-policy\\.ts$",
  "^src/domain/release-proposal\\.ts$",
  "^src/orchestrator/release-service\\.ts$",
  "^src/ports/release-run-store\\.ts$",
  "^src/adapters/sqlite-release-run-store\\.ts$",
] as const;

export const ReleasePolicySchema = z.object({
  maxFiles: z.number().int().min(1).max(200).default(15),
  maxChangedLines: z.number().int().min(1).max(50_000).default(400),
  /** 红线路径 regex source 列表；缺省=DEFAULT_PROTECTED_PATH_SOURCES。非法 source 编译失败时按未配置该项并在 verdict 给 warning */
  protectedPaths: z.array(z.string().min(1)).default([...DEFAULT_PROTECTED_PATH_SOURCES]),
  /** 修改既有测试文件→拒绝（防测试篡改；新增测试文件放行） */
  disallowModifiedTests: z.boolean().default(true),
  /** 单 workflow 每自然日自动合并上限（0=不限制；配额判定由调用方持 RateLimiter 执行） */
  dailyAutoMergeQuota: z.number().int().min(0).max(50).default(3),
  /** 出现 rolled_back 后该 workflow 自动合并冷却小时数（0=不冷却） */
  cooldownHoursOnRollback: z.number().int().min(0).max(24 * 7).default(24),
});
export type ReleasePolicy = z.infer<typeof ReleasePolicySchema>;

/** 平台 diff 归一后的单文件变更（路径恒 git 风格 / 分隔） */
export interface DiffEntry {
  path: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
}

/** 统一 diff patch 文本行数统计（+/- 行，排除 +++/--- 头） */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function asArray(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown): boolean {
  return v === true;
}

/**
 * 三平台 MR 变更清单归一：
 * - github/gitee：根数组，{ filename|old_path/new_path?, additions?, deletions?, patch?, status? }
 * - jihulab(GitLab)：根数组，{ new_path, old_path, diff, new_file?, deleted_file?, renamed_file? }
 * 数值字段缺省时从 patch 文本统计（平台无关，最可靠）。
 */
export function normalizeMrDiff(payload: unknown, provider: string): DiffEntry[] {
  const entries = asArray(payload);
  const out: DiffEntry[] = [];
  for (const item of entries) {
    const isGitlab = provider === "jihulab";
    const path =
      str(item.new_path) || str(item.filename) || str(item.old_path) || str(item.path);
    if (!path) continue;
    const patch = str(item.diff) || str(item.patch);
    const counted = patch ? countPatchLines(patch) : { additions: 0, deletions: 0 };
    const additions = typeof item.additions === "number" ? item.additions : counted.additions;
    const deletions = typeof item.deletions === "number" ? item.deletions : counted.deletions;
    const status = str(item.status);
    out.push({
      path,
      additions,
      deletions,
      isNew: isGitlab ? bool(item.new_file) : status === "added" || bool(item.new_file),
      isDeleted: isGitlab
        ? bool(item.deleted_file)
        : status === "removed" || status === "deleted" || bool(item.deleted_file),
    });
  }
  return out;
}

export interface ReleaseProposalFacts {
  entries: DiffEntry[];
  /** MR 源分支 HEAD sha */
  headSha: string;
  /** MR 创建时的目标分支基点 sha（平台 MR base） */
  baseSha: string;
  /** 目标分支（master）当前 HEAD sha */
  masterHeadSha: string;
}

export interface ReleaseVerdict {
  allow: boolean;
  /** 逐条拒绝原因（可审计、可回显通知）；allow=true 时为空 */
  reasons: string[];
  /** 配置告警（如红线路径正则编译失败）——不影响 verdict 但须展示给 admin */
  warnings: string[];
}

const TEST_FILE_RE = /(^|\/)(test|tests|__tests__)(\/|$)|\.test\.|\.spec\./;

/** 编译策略的红线路径；非法 source 跳过并产出 warning（不静默吞配置错误） */
export function compileProtectedPaths(policy: ReleasePolicy): {
  patterns: RegExp[];
  warnings: string[];
} {
  const patterns: RegExp[] = [];
  const warnings: string[] = [];
  for (const source of policy.protectedPaths) {
    try {
      patterns.push(new RegExp(source));
    } catch {
      warnings.push(`红线路径正则编译失败，已跳过：${source}`);
    }
  }
  return { patterns, warnings };
}

/**
 * 提案放行判定（spec §4.3）。任何一条不满足即整体拒绝—— reasons 逐条可回显。
 * 一致性校验：masterHeadSha 必须 === baseSha（严格相等，防并行提案竞态）。
 */
export function evaluateReleaseProposal(
  facts: ReleaseProposalFacts,
  policy: ReleasePolicy,
): ReleaseVerdict {
  const reasons: string[] = [];
  const { patterns, warnings } = compileProtectedPaths(policy);

  if (!facts.headSha || !/^[0-9a-f]{7,40}$/i.test(facts.headSha)) {
    reasons.push("MR head sha 缺失或非法，无法定位被测产物");
  }
  if (facts.baseSha && facts.masterHeadSha) {
    if (facts.baseSha.toLowerCase() !== facts.masterHeadSha.toLowerCase()) {
      reasons.push(
        `master 已前进（提案基点 ${facts.baseSha.slice(0, 8)} ≠ 当前 ${facts.masterHeadSha.slice(0, 8)}），需人工重估`,
      );
    }
  } else {
    reasons.push("master 基点 sha 无法取得，一致性校验失败");
  }
  if (facts.entries.length === 0) {
    reasons.push("diff 为空或变更清单不可得");
  }
  if (facts.entries.length > policy.maxFiles) {
    reasons.push(`变更文件数 ${facts.entries.length} 超过上限 ${policy.maxFiles}`);
  }
  const totalLines = facts.entries.reduce((sum, e) => sum + e.additions + e.deletions, 0);
  if (totalLines > policy.maxChangedLines) {
    reasons.push(`变更行数 ${totalLines} 超过上限 ${policy.maxChangedLines}`);
  }
  for (const entry of facts.entries) {
    const hit = patterns.find((re) => re.test(entry.path));
    if (hit) {
      reasons.push(`触碰红线路径：${entry.path}（规则 ${hit.source}）`);
    }
    if (
      policy.disallowModifiedTests &&
      !entry.isNew &&
      TEST_FILE_RE.test(entry.path)
    ) {
      reasons.push(`修改既有测试文件（防测试篡改）：${entry.path}`);
    }
  }
  return { allow: reasons.length === 0, reasons: [...new Set(reasons)], warnings };
}
