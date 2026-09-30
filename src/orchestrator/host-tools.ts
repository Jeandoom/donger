// donger-host MCP 工具集 v2（spec 2026-09-30-deploy-ops-loop-design §6）：
// 主机资产制——工具入参一律 hostId（登记资产，防横向移动）。只读诊断走固定命令模板
// （参数 regex 收口）免审批；写操作两工具（host_exec/host_logs_clean）挂 host-ops
// force 门（full_access 不豁免）。部署逻辑不在平台：agent 读仓库 deploy 脚本后经
// host_exec 构造命令执行，每次审批留痕（部署即会话，审计即记录）。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Host, REMOTE_PATH_PATTERN } from "../domain/host.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { HostStore } from "../ports/host-store.js";
import type { SshAuthMaterial, SshCommandRunner } from "../ports/ssh-command-runner.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const MAX_OUTPUT_CHARS = 40_000;
const DIAG_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 600_000;

export interface HostToolsViewer {
  id: string;
  role: "admin" | "user";
}

export interface HostToolsDeps {
  viewer: HostToolsViewer;
  hostStore: HostStore;
  sshRunner: SshCommandRunner;
  credentialSets: CredentialSetStore;
}

/** 挂载判定：admin 或名下存在 enabled 主机（orchestrator 装配处调用） */
export async function canViewerUseHostTools(
  store: HostStore,
  viewer: HostToolsViewer,
): Promise<boolean> {
  if (viewer.role === "admin") return true;
  const hosts = await store.listHosts();
  return hosts.some((h) => h.ownerId === viewer.id && h.enabled);
}

/** 主机登记制：按 hostId 解析并校验可见性（owner/admin；不存在/越权统一提示） */
async function visibleHost(
  deps: HostToolsDeps,
  hostId: string,
): Promise<{ host: Host } | { error: ToolResult }> {
  const host = await deps.hostStore.get(hostId);
  if (!host) return { error: fail(`主机不存在：${hostId}`) };
  if (!host.enabled) return { error: fail(`主机「${host.name}」已停用`) };
  if (deps.viewer.role !== "admin" && host.ownerId !== deps.viewer.id) {
    return { error: fail(`无权访问主机 ${hostId}（仅属主或管理员）`) };
  }
  return { host };
}

/** 解析主机 SSH 凭证（按 host 属主，generic 模板键 private_key/password） */
export async function resolveSshAuth(
  credentialSets: CredentialSetStore,
  host: Host,
): Promise<SshAuthMaterial> {
  const [filled] = await credentialSets.getFilledValues(host.ownerId, [host.credentialCode]);
  const values = filled?.values ?? {};
  const auth: SshAuthMaterial = {};
  if (values.private_key) auth.privateKey = values.private_key;
  if (values.password) auth.password = values.password;
  if (!auth.privateKey && !auth.password) {
    throw new Error(
      `SSH 凭证未填写：主机 ${host.name} 引用模板 ${host.credentialCode}（需 private_key 或 password 至少其一）`,
    );
  }
  return auth;
}

async function sshRun(
  deps: HostToolsDeps,
  host: Host,
  command: string,
  timeoutMs = DIAG_TIMEOUT_MS,
): Promise<ToolResult> {
  try {
    const auth = await resolveSshAuth(deps.credentialSets, host);
    const r = await deps.sshRunner(
      { host: host.host, port: host.port, username: host.username },
      auth,
      command,
      { timeoutMs },
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

export function hostToolDefinitions(deps: HostToolsDeps): SdkMcpToolDefinition[] {
  const HostIdShape = {
    hostId: z.string().min(1).describe("主机 id（hosts_list 查询）"),
  };

  return [
    {
      name: "hosts_list",
      description: "列出可见的登记主机（名称、端点、凭证模板、启用状态）",
      inputSchema: {},
      handler: async (): Promise<ToolResult> => {
        const all = await deps.hostStore.listHosts();
        const visible = all.filter(
          (h) => deps.viewer.role === "admin" || h.ownerId === deps.viewer.id,
        );
        return ok(
          visible.length
            ? visible
                .map(
                  (h) =>
                    `- ${h.id}｜${h.name}｜${h.username}@${h.host}:${h.port}｜凭证=${h.credentialCode}｜${h.enabled ? "启用" : "停用"}${h.description ? `｜${h.description}` : ""}`,
                )
                .join("\n")
            : "（无可见主机，请管理员在主机页登记）",
        );
      },
    },
    {
      name: "host_status",
      description: "主机总览：系统版本/负载/根分区与 /var 磁盘/CPU 前 15 进程（只读诊断）",
      inputSchema: HostIdShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(HostIdShape).parse(args);
        const r = await visibleHost(deps, a.hostId);
        if ("error" in r) return r.error;
        return sshRun(
          deps,
          r.host,
          "uname -a; echo; uptime; echo; df -h / /var; echo; ps aux --sort=-%cpu | head -16",
        );
      },
    },
    {
      name: "host_disk_usage",
      description: "主机磁盘占用（df -h，缺省根分区）",
      inputSchema: {
        ...HostIdShape,
        path: z.string().regex(REMOTE_PATH_PATTERN).optional().describe("绝对路径（缺省 /）"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...HostIdShape, path: z.string().optional() }).parse(args);
        if (a.path && !REMOTE_PATH_PATTERN.test(a.path)) return fail("path 须为无元字符的绝对路径");
        const r = await visibleHost(deps, a.hostId);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, `df -h ${a.path ?? "/"}`);
      },
    },
    {
      name: "host_process_top",
      description: "主机 CPU 占用前 N 进程（ps aux）",
      inputSchema: { ...HostIdShape, count: z.number().int().min(1).max(50).default(15) },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...HostIdShape, count: z.number().optional() }).parse(args);
        const r = await visibleHost(deps, a.hostId);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, `ps aux --sort=-%cpu | head -${a.count ?? 15}`);
      },
    },
    {
      name: "host_logs_tail",
      description: "查看主机日志文件尾部（只读；文件须为绝对路径）",
      inputSchema: {
        ...HostIdShape,
        file: z.string().regex(REMOTE_PATH_PATTERN).describe("日志文件绝对路径"),
        lines: z.number().int().min(1).max(2000).default(200),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...HostIdShape, file: z.string(), lines: z.number().optional() })
          .parse(args);
        if (!REMOTE_PATH_PATTERN.test(a.file)) return fail("file 须为无元字符的绝对路径");
        const r = await visibleHost(deps, a.hostId);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, `tail -n ${a.lines ?? 200} ${a.file}`);
      },
    },
    {
      name: "host_logs_clean",
      description:
        "截断主机日志文件（保留末尾 N 行；写操作，会弹审批卡确认）——磁盘打满时的自愈动作",
      inputSchema: {
        ...HostIdShape,
        file: z.string().regex(REMOTE_PATH_PATTERN).describe("日志文件绝对路径"),
        keepLines: z.number().int().min(1).max(100_000).default(1000).describe("保留末尾行数"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...HostIdShape, file: z.string(), keepLines: z.number().optional() })
          .parse(args);
        if (!REMOTE_PATH_PATTERN.test(a.file)) return fail("file 须为无元字符的绝对路径");
        const r = await visibleHost(deps, a.hostId);
        if ("error" in r) return r.error;
        const keep = a.keepLines ?? 1000;
        // 临时文件+mv 原子替换，避免 > 重定向自身导致的清空竞态
        return sshRun(
          deps,
          r.host,
          `tail -n ${keep} ${a.file} > ${a.file}.donger-tmp && mv ${a.file}.donger-tmp ${a.file} && wc -l ${a.file}`,
        );
      },
    },
    {
      name: "host_exec",
      description:
        "在主机上执行任意单行 shell 命令（写操作，一律弹审批卡人工确认——命令内容会完整展示给审批人）。" +
        "用于部署（如 `cd /srv/app && ./deploy.sh`）、重启服务、运行仓库脚本等。需要 root 的命令要求主机已配置受限 sudoers NOPASSWD；不支持交互式命令（无 tty）",
      inputSchema: {
        ...HostIdShape,
        command: z
          .string()
          .min(1)
          .max(600)
          .refine((v) => !/[\r\n]/.test(v), "命令必须为单行"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...HostIdShape, command: z.string() }).parse(args);
        if (a.command.length > 600 || /[\r\n]/.test(a.command)) {
          return fail("命令必须为单行且不超过 600 字符");
        }
        const r = await visibleHost(deps, a.hostId);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, a.command, EXEC_TIMEOUT_MS);
      },
    },
  ];
}

export function createHostToolsServer(deps: HostToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-host",
    version: "2.0.0",
    tools: hostToolDefinitions(deps),
  });
}
