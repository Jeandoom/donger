// donger-host MCP 工具集：agent 面向登记目标的受限远程运维通道（目标登记制——
// 一切入参 targetId，先校验可见性 owner/admin，防横向移动）。诊断命令为固定模板
// （tail/df/ps），参数 regex 收口；写操作三工具由 default-gates 的 host-ops force 门
// 拦截审批（full_access 不豁免）。SSH 凭证按 target 属主解析，不进 agent 上下文。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type DeployStep, type DeployTarget, REMOTE_LOG_FILE_PATTERN } from "../domain/deploy.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { DeployStore } from "../ports/deploy-store.js";
import type { SshCommandRunner } from "../ports/ssh-command-runner.js";
import type { DeployExecutor } from "./deploy-executor.js";
import { resolveSshAuth } from "./deploy-executor.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const MAX_OUTPUT_CHARS = 40_000;
const DIAG_TIMEOUT_MS = 30_000;

export interface HostToolsViewer {
  id: string;
  role: "admin" | "user";
}

export interface HostToolsDeps {
  viewer: HostToolsViewer;
  deployStore: DeployStore;
  executor: DeployExecutor;
  sshRunner: SshCommandRunner;
  credentialSets: CredentialSetStore;
}

/** 挂载判定：admin 或名下存在 enabled 部署目标（orchestrator 装配处调用） */
export async function canViewerUseHostTools(
  store: DeployStore,
  viewer: HostToolsViewer,
): Promise<boolean> {
  if (viewer.role === "admin") return true;
  const targets = await store.listEnabledTargets();
  return targets.some((t) => t.ownerId === viewer.id);
}

/** 目标登记制：按 targetId 解析并校验可见性（owner/admin；不存在/越权统一提示） */
async function visibleTarget(
  deps: HostToolsDeps,
  targetId: string,
): Promise<{ target: DeployTarget } | { error: ToolResult }> {
  const target = await deps.deployStore.getTarget(targetId);
  if (!target) return { error: fail(`部署目标不存在：${targetId}`) };
  if (deps.viewer.role !== "admin" && target.ownerId !== deps.viewer.id) {
    return { error: fail(`无权访问部署目标 ${targetId}（仅属主或管理员）`) };
  }
  return { target };
}

async function sshRun(
  deps: HostToolsDeps,
  target: DeployTarget,
  command: string,
): Promise<ToolResult> {
  try {
    const auth = await resolveSshAuth(deps.credentialSets, target);
    const r = await deps.sshRunner(
      { host: target.ssh.host, port: target.ssh.port, username: target.ssh.username },
      auth,
      command,
      { timeoutMs: DIAG_TIMEOUT_MS },
    );
    const body = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (r.exitCode !== 0) {
      return fail(`远程命令退出码 ${r.exitCode}：${body.slice(-2000)}`);
    }
    return ok(
      body.length > MAX_OUTPUT_CHARS
        ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n…（已截断）`
        : body || "（无输出）",
    );
  } catch (e) {
    return fail(`SSH 执行失败：${(e as Error).message}`);
  }
}

function stepsSummary(steps: DeployStep[]): string {
  return steps
    .map(
      (s) =>
        `${s.name}: exit=${s.exitCode} ${s.durationMs}ms${s.outputTail ? `\n${s.outputTail}` : ""}`,
    )
    .join("\n");
}

export function hostToolDefinitions(deps: HostToolsDeps): SdkMcpToolDefinition[] {
  const TargetIdShape = {
    targetId: z.string().min(1).describe("部署目标 id（deploy_targets_list 查询）"),
  };

  return [
    {
      name: "deploy_targets_list",
      description: "列出可见的部署目标（服务、仓库、分支、自动部署开关、最近部署状态）",
      inputSchema: {},
      handler: async (): Promise<ToolResult> => {
        const all = await deps.deployStore.listTargets();
        const visible = all.filter(
          (t) => deps.viewer.role === "admin" || t.ownerId === deps.viewer.id,
        );
        const lines = await Promise.all(
          visible.map(async (t) => {
            const last = await deps.deployStore.getLastSuccessOrder(t.id);
            return `- ${t.id}｜${t.name}（service=${t.service}）｜${t.provider}:${t.repoUrl}#${t.branch}｜自动部署=${t.autoDeploy ? "开" : "关"}｜最近成功=${last?.sha?.slice(0, 8) ?? "无"}`;
          }),
        );
        return ok(lines.length ? lines.join("\n") : "（无可见部署目标）");
      },
    },
    {
      name: "host_status",
      description: "目标主机总览：系统版本/负载/磁盘/进程 CPU 前 15（只读诊断）",
      inputSchema: TargetIdShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(TargetIdShape).parse(args);
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        return sshRun(
          deps,
          r.target,
          `uname -a; echo; uptime; echo; df -h ${r.target.workdir}; echo; ps aux --sort=-%cpu | head -16`,
        );
      },
    },
    {
      name: "host_disk_usage",
      description: "目标主机磁盘占用（df -h，缺省部署目录）",
      inputSchema: {
        ...TargetIdShape,
        path: z
          .string()
          .regex(REMOTE_LOG_FILE_PATTERN)
          .optional()
          .describe("绝对路径（缺省部署目录）"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...TargetIdShape, path: z.string().optional() }).parse(args);
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        return sshRun(deps, r.target, `df -h ${a.path ?? r.target.workdir}`);
      },
    },
    {
      name: "host_process_top",
      description: "目标主机 CPU 占用前 N 进程（ps aux）",
      inputSchema: { ...TargetIdShape, count: z.number().int().min(1).max(50).default(15) },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...TargetIdShape, count: z.number().optional() }).parse(args);
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        return sshRun(deps, r.target, `ps aux --sort=-%cpu | head -${a.count ?? 15}`);
      },
    },
    {
      name: "host_logs_tail",
      description: "查看目标主机日志文件尾部（只读；文件须为绝对路径）",
      inputSchema: {
        ...TargetIdShape,
        file: z.string().regex(REMOTE_LOG_FILE_PATTERN).describe("日志文件绝对路径"),
        lines: z.number().int().min(1).max(2000).default(200),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...TargetIdShape, file: z.string(), lines: z.number().optional() })
          .parse(args);
        if (!REMOTE_LOG_FILE_PATTERN.test(a.file)) return fail("file 须为无元字符的绝对路径");
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        return sshRun(deps, r.target, `tail -n ${a.lines ?? 200} ${a.file}`);
      },
    },
    {
      name: "host_logs_clean",
      description:
        "截断目标主机日志文件（保留末尾 N 行；写操作，会弹审批卡确认）——磁盘打满时的自愈动作",
      inputSchema: {
        ...TargetIdShape,
        file: z.string().regex(REMOTE_LOG_FILE_PATTERN).describe("日志文件绝对路径"),
        keepLines: z.number().int().min(1).max(100_000).default(1000).describe("保留末尾行数"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...TargetIdShape, file: z.string(), keepLines: z.number().optional() })
          .parse(args);
        if (!REMOTE_LOG_FILE_PATTERN.test(a.file)) return fail("file 须为无元字符的绝对路径");
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        const keep = a.keepLines ?? 1000;
        // 临时文件+mv 原子替换，避免 > 重定向自身导致的清空竞态
        return sshRun(
          deps,
          r.target,
          `tail -n ${keep} ${a.file} > ${a.file}.donger-tmp && mv ${a.file}.donger-tmp ${a.file} && wc -l ${a.file}`,
        );
      },
    },
    {
      name: "service_deploy",
      description:
        "部署指定目标（执行其部署剧本：prepare 命令→健康检查；写操作，会弹审批卡确认）。ref 缺省用分支最新提交",
      inputSchema: {
        ...TargetIdShape,
        ref: z.string().max(120).optional().describe("部署指向（sha/tag/分支，缺省分支 HEAD）"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...TargetIdShape, ref: z.string().optional() }).parse(args);
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        try {
          const order = await deps.executor.run(r.target, {
            trigger: "agent",
            ...(a.ref ? { ref: a.ref } : {}),
          });
          return order.status === "success"
            ? ok(
                `部署成功：${r.target.name}（${order.ref}${order.sha ? ` @${order.sha.slice(0, 8)}` : ""}）\n${stepsSummary(order.steps)}`,
              )
            : fail(`部署失败：${r.target.name}——${order.error}\n${stepsSummary(order.steps)}`);
        } catch (e) {
          return fail(`部署执行异常：${(e as Error).message}`);
        }
      },
    },
    {
      name: "service_restart",
      description: "重启指定目标服务（执行其重启剧本；写操作，会弹审批卡确认）",
      inputSchema: TargetIdShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(TargetIdShape).parse(args);
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        try {
          const steps = await deps.executor.runRestart(r.target);
          return ok(`重启完成：${r.target.name}\n${stepsSummary(steps)}`);
        } catch (e) {
          return fail(`重启失败：${(e as Error).message}`);
        }
      },
    },
    {
      name: "deploy_status",
      description: "目标最近部署单（状态/触发源/步骤退出码；只读）",
      inputSchema: TargetIdShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(TargetIdShape).parse(args);
        const r = await visibleTarget(deps, a.targetId);
        if ("error" in r) return r.error;
        const orders = await deps.deployStore.listOrders(a.targetId, 5);
        if (!orders.length) return ok(`（${r.target.name} 无部署记录）`);
        return ok(
          orders
            .map(
              (o) =>
                `${o.startedAt}｜${o.status}｜触发=${o.trigger}｜ref=${o.ref ?? "-"}${o.sha ? ` @${o.sha.slice(0, 8)}` : ""}${o.error ? `｜${o.error}` : ""}`,
            )
            .join("\n"),
        );
      },
    },
  ];
}

export function createHostToolsServer(deps: HostToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-host",
    version: "1.0.0",
    tools: hostToolDefinitions(deps),
  });
}
