// donger-host MCP 工具集 v3（spec 2026-09-30-deploy-ops-loop-design §6 模型合并）：
// 主机=凭证（kind=host）——工具入参一律主机凭证 code（防横向移动：仅登记过的主机）。
// 只读诊断走固定命令模板（参数 regex 收口）免审批；写操作两工具（host_exec/
// host_logs_clean）挂 host-ops force 门（full_access 不豁免）。端点与密钥按当前
// 用户凭证值现取（值永不进 prompt/审计/输出），部署逻辑在仓库与技能里。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type CredentialTemplate, sshEndpointFromValues } from "../domain/credential.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { SshCommandRunner } from "../ports/ssh-command-runner.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const MAX_OUTPUT_CHARS = 40_000;
const DIAG_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 600_000;
/** 目标机绝对路径（诊断类工具入参的元字符收口） */
const REMOTE_PATH_PATTERN = /^\/[\w.\-/]{0,240}$/;

export interface HostToolsViewer {
  id: string;
  role: "admin" | "user";
}

export interface HostToolsDeps {
  viewer: HostToolsViewer;
  credentialSets: CredentialSetStore;
  sshRunner: SshCommandRunner;
}

interface ResolvedHost {
  code: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

/** 挂载判定：admin，或名下已填值的 host 凭证存在（orchestrator 装配处调用） */
export async function canViewerUseHostTools(
  credentialSets: CredentialSetStore,
  viewer: HostToolsViewer,
): Promise<boolean> {
  if (viewer.role === "admin") return true;
  const templates = (await credentialSets.listTemplates({})).filter((t) => t.kind === "host");
  if (!templates.length) return false;
  const filled = new Set(await credentialSets.listValueCodes(viewer.id));
  return templates.some((t) => filled.has(t.code));
}

/** 主机登记制：按凭证 code 解析当前用户的端点与认证（值缺失/未登记统一提示） */
async function resolveHost(
  deps: HostToolsDeps,
  code: string,
): Promise<{ host: ResolvedHost } | { error: ToolResult }> {
  const template = await deps.credentialSets.getTemplate(code);
  if (!template || template.kind !== "host") {
    return { error: fail(`主机凭证不存在：${code}（hostId 概念已退役，入参用凭证 code）`) };
  }
  const [filled] = await deps.credentialSets.getFilledValues(deps.viewer.id, [code]);
  try {
    const ep = sshEndpointFromValues(filled?.values, code);
    return { host: { code, name: template.name, ...ep } };
  } catch (e) {
    return { error: fail((e as Error).message) };
  }
}

async function sshRun(
  deps: HostToolsDeps,
  host: ResolvedHost,
  command: string,
  timeoutMs = DIAG_TIMEOUT_MS,
): Promise<ToolResult> {
  try {
    const r = await deps.sshRunner(
      { host: host.host, port: host.port, username: host.username },
      {
        ...(host.password ? { password: host.password } : {}),
        ...(host.privateKey ? { privateKey: host.privateKey } : {}),
      },
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
  const HostCodeShape = {
    hostCode: z.string().min(1).describe("主机凭证 code（hosts_list 查询）"),
  };

  return [
    {
      name: "hosts_list",
      description: "列出可见的主机凭证（kind=host，含配置状态与说明）",
      inputSchema: {},
      handler: async (): Promise<ToolResult> => {
        const templates = (await deps.credentialSets.listTemplates({})).filter(
          (t: CredentialTemplate) => t.kind === "host",
        );
        if (!templates.length)
          return ok("（暂无主机凭证；管理员可在凭证页创建 host 类模板并填写主机值）");
        const filled = new Set(await deps.credentialSets.listValueCodes(deps.viewer.id));
        return ok(
          templates
            .map(
              (t) =>
                `- ${t.code}｜${t.name}｜${filled.has(t.code) ? "已配置" : "未配置（当前用户不可用）"}${t.description ? `｜${t.description}` : ""}`,
            )
            .join("\n"),
        );
      },
    },
    {
      name: "host_status",
      description: "主机总览：系统版本/负载/根分区与 /var 磁盘/CPU 前 15 进程（只读诊断）",
      inputSchema: HostCodeShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(HostCodeShape).parse(args);
        const r = await resolveHost(deps, a.hostCode);
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
        ...HostCodeShape,
        path: z.string().regex(REMOTE_PATH_PATTERN).optional().describe("绝对路径（缺省 /）"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...HostCodeShape, path: z.string().optional() }).parse(args);
        if (a.path && !REMOTE_PATH_PATTERN.test(a.path)) return fail("path 须为无元字符的绝对路径");
        const r = await resolveHost(deps, a.hostCode);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, `df -h ${a.path ?? "/"}`);
      },
    },
    {
      name: "host_process_top",
      description: "主机 CPU 占用前 N 进程（ps aux）",
      inputSchema: { ...HostCodeShape, count: z.number().int().min(1).max(50).default(15) },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...HostCodeShape, count: z.number().optional() }).parse(args);
        const r = await resolveHost(deps, a.hostCode);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, `ps aux --sort=-%cpu | head -${a.count ?? 15}`);
      },
    },
    {
      name: "host_logs_tail",
      description: "查看主机日志文件尾部（只读；文件须为绝对路径）",
      inputSchema: {
        ...HostCodeShape,
        file: z.string().regex(REMOTE_PATH_PATTERN).describe("日志文件绝对路径"),
        lines: z.number().int().min(1).max(2000).default(200),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...HostCodeShape, file: z.string(), lines: z.number().optional() })
          .parse(args);
        if (!REMOTE_PATH_PATTERN.test(a.file)) return fail("file 须为无元字符的绝对路径");
        const r = await resolveHost(deps, a.hostCode);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, `tail -n ${a.lines ?? 200} ${a.file}`);
      },
    },
    {
      name: "host_logs_clean",
      description:
        "截断主机日志文件（保留末尾 N 行；写操作，会弹审批卡确认）——磁盘打满时的自愈动作",
      inputSchema: {
        ...HostCodeShape,
        file: z.string().regex(REMOTE_PATH_PATTERN).describe("日志文件绝对路径"),
        keepLines: z.number().int().min(1).max(100_000).default(1000).describe("保留末尾行数"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...HostCodeShape, file: z.string(), keepLines: z.number().optional() })
          .parse(args);
        if (!REMOTE_PATH_PATTERN.test(a.file)) return fail("file 须为无元字符的绝对路径");
        const r = await resolveHost(deps, a.hostCode);
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
        ...HostCodeShape,
        command: z
          .string()
          .min(1)
          .max(600)
          .refine((v) => !/[\r\n]/.test(v), "命令必须为单行"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...HostCodeShape, command: z.string() }).parse(args);
        if (a.command.length > 600 || /[\r\n]/.test(a.command)) {
          return fail("命令必须为单行且不超过 600 字符");
        }
        const r = await resolveHost(deps, a.hostCode);
        if ("error" in r) return r.error;
        return sshRun(deps, r.host, a.command, EXEC_TIMEOUT_MS);
      },
    },
  ];
}

export function createHostToolsServer(deps: HostToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-host",
    version: "3.0.0",
    tools: hostToolDefinitions(deps),
  });
}
