// dev server 托管工具（dev-server，2026-11-04-webgame-dev-loop-design.md §3.3）：
// 平台托管会话 dev server（起/查/日志/停），产出 /preview/<convId>/ 同源预览地址供用户
// 平台内预览与 playwright e2e。写边界 = 会话 + 项目根（构造时闭包绑定）；模型传其他
// 会话不可达（会话工具面按 run 构造，天然隔离）。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveWithinRoots } from "../domain/file-browser.js";
import { DevServerError, previewUrl, type DevServerService } from "./dev-server-service.js";

export interface DevServerToolsDeps {
  conversationId: string;
  ownerId: string;
  agentId: string | null;
  /** 项目根：git agent = 会话 reposRoot（<…>/worktrees/<convId>/repos），否则 agent workspace */
  root: string;
  service: DevServerService;
}

/** MCP 工具返回（结构兼容 SDK CallToolResult） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function devServerToolDefinitions(deps: DevServerToolsDeps): SdkMcpToolDefinition[] {
  const resolveDir = (dir: string | undefined): string | { error: string } => {
    if (!dir) return deps.root;
    const r = resolveWithinRoots([deps.root], dir);
    return r.ok ? r.abs : { error: `目录越界：${dir} 不在项目根内（禁止绝对路径与 .. 穿越）` };
  };
  const errMsg = (e: unknown): string => {
    if (e instanceof DevServerError) {
      const logs = e.detail?.logs?.length ? `\n最近日志：\n${e.detail.logs.join("\n")}` : "";
      return `${e.message}${logs}`;
    }
    return e instanceof Error ? e.message : String(e);
  };
  return [
    {
      name: "dev_start",
      description:
        "启动本会话的开发服务器（平台托管，127.0.0.1 随机口），返回平台内预览地址 /preview/<会话>/。"
        + "缺省命令为 vite 约定 npm run dev -- --port {port} --strictPort --host 127.0.0.1；"
        + "next 等传 cmd（须含 {port} 占位，如 \"npm run dev -- -p {port}\"）。"
        + "已启动时幂等返回既有地址。启动成功后：把预览地址告诉用户（平台内可直接预览），"
        + "e2e 验证用 playwright 工具打开该地址并截图留证（保存到当前工作目录 .shots/）。",
      inputSchema: {
        dir: z.string().max(300).optional().describe("项目子目录（相对项目根，缺省=根）"),
        cmd: z.string().max(500).optional().describe('启动命令（含 {port} 占位；缺省 vite 约定）'),
      },
      handler: async ({ dir, cmd }) => {
        const cwd = resolveDir(dir ?? undefined);
        if (typeof cwd !== "string") return fail(cwd.error);
        try {
          const handle = await deps.service.start({
            conversationId: deps.conversationId,
            ownerId: deps.ownerId,
            agentId: deps.agentId,
            cwd,
            cmd: cmd ?? undefined,
          });
          return ok(
            (handle.reused
              ? "dev server 已在运行（幂等返回）"
              : "dev server 已启动")
              + `\n预览地址：${handle.url}`
            + `\n用户可在平台对话/文件面板打开该地址预览；e2e 请用 playwright 工具访问它并截图到 .shots/`,
          );
        } catch (e) {
          return fail(errMsg(e));
        }
      },
    },
    {
      name: "dev_status",
      description: "查询本会话 dev server 运行状态（端口/预览地址/启动时间）",
      inputSchema: {},
      handler: async () => {
        const entry = await deps.service.status(deps.conversationId);
        if (!entry) return ok("未运行");
        return ok(
          JSON.stringify(
            {
              port: entry.port,
              url: previewUrl(deps.conversationId),
              cmd: entry.cmd,
              startedAt: entry.startedAt,
              lastAccessAt: entry.lastAccessAt,
            },
            null,
            2,
          ),
        );
      },
    },
    {
      name: "dev_logs",
      description: "读取本会话 dev server 最近日志（诊断启动失败/运行报错）",
      inputSchema: {
        lines: z.number().int().min(1).max(200).optional().describe("返回行数（缺省 30）"),
      },
      handler: async ({ lines }) => {
        const rows = deps.service.logs(deps.conversationId, lines ?? 30);
        return rows.length === 0 ? ok("无日志（未运行或无输出）") : ok(rows.join("\n"));
      },
    },
    {
      name: "dev_stop",
      description: "停止本会话 dev server（会话收尾/释放并发额度时调用；闲置超时平台也会自动回收）",
      inputSchema: {},
      handler: async () => {
        const stopped = await deps.service.stop(deps.conversationId);
        return stopped ? ok("已停止") : fail("未在运行");
      },
    },
  ];
}

/** 构造 in-process dev server 托管工具 MCP server（注入 RunOptions.devServerTools） */
export function createDevServerToolsServer(deps: DevServerToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "dev-server",
    version: "0.1.0",
    tools: devServerToolDefinitions(deps),
  });
}
