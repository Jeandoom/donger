// codex 引擎 MCP 桥执行客户端（2026-11-05 codex-namespace 专项）。
// 背景：codex 0.155 把 mcp_servers 工具暴露为 namespace 型聚合工具，donger 桥的
// responses→chat 翻译只映射 function 型 → 模型永远看不到 MCP 工具（spec
// 2026-11-04-webgame-dev-loop-design §4b 双引擎冒烟实锤）。修复形态（协议实验
// scripts/tmp-mock-probe.cjs e1 实证）：桥把这些 MCP 工具展平为 function 工具注入
// 上游 chat 请求，模型 tool_call 回来由桥直接执行，以 function_call+function_call_output
// 内联回传 codex——绕开 codex 路由对 namespace 调用不支持的限制。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface BridgeMcpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** 单个 MCP server 的桥执行客户端：listTools 供展平注入，callTool 供内联执行 */
export interface BridgeMcpClient {
  readonly serverName: string;
  listTools(): Promise<BridgeMcpToolDef[]>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

/** MCP tool result → 纯文本（text 直取；image 给占位说明，像素由模型自行 view_image/Read 文件） */
function resultToText(result: unknown): string {
  const r = (result ?? {}) as {
    content?: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
    isError?: boolean;
  };
  const parts: string[] = [];
  for (const block of Array.isArray(r.content) ? r.content : []) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "image") {
      const bytes = typeof block.data === "string" ? block.data.length : 0;
      parts.push(`[图片内容 ${block.mimeType ?? "image"} ~${bytes}B base64，文件已由工具落盘，可用 view_image/Read 查看]`);
    } else if (block?.type === "resource") {
      parts.push("[资源内容已返回]");
    }
  }
  const text = parts.join("\n") || "(空结果)";
  return r.isError ? `MCP 工具错误：${text}` : text;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 共用骨架：懒连接 + 单例 Client（连接失败不缓存，允许下次重试） */
abstract class BaseBridgeMcpClient implements BridgeMcpClient {
  abstract readonly serverName: string;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private closeTransport: (() => Promise<void>) | null = null;

  protected abstract openTransport(): Promise<{
    transport: never;
    closeTransport: () => Promise<void>;
  }>;

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: "donger-bridge", version: "0.1.0" });
        const { transport, closeTransport } = await this.openTransport();
        await client.connect(transport);
        this.closeTransport = closeTransport;
        return client;
      })();
      this.connecting.catch(() => {
        this.connecting = null;
      });
    }
    this.client = await this.connecting;
    return this.client;
  }

  async listTools(): Promise<BridgeMcpToolDef[]> {
    const client = await withTimeout(this.ensureClient(), CONNECT_TIMEOUT_MS, `${this.serverName} MCP 连接`);
    const res = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      `${this.serverName} tools/list`,
    );
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      ...(typeof t.description === "string" ? { description: t.description } : {}),
      ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.ensureClient();
    const res = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `${this.serverName}.${toolName}`,
    );
    return resultToText(res);
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // 连接从未建立/已断开：忽略
    }
    this.client = null;
    try {
      await this.closeTransport?.();
    } catch {
      // transport 已关
    }
    this.closeTransport = null;
  }
}

/** in-process SDK MCP server 实例（kb/host/dedup/dev-server 等平台工具台） */
export class InProcessBridgeMcpClient extends BaseBridgeMcpClient {
  constructor(
    readonly serverName: string,
    private readonly instance: unknown,
  ) {
    super();
  }
  protected async openTransport(): Promise<{
    transport: never;
    closeTransport: () => Promise<void>;
  }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await (this.instance as { connect(transport: unknown): Promise<void> }).connect(serverTransport);
    return { transport: clientTransport as never, closeTransport: () => serverTransport.close() };
  }
}

/** agent 连接器 stdio MCP server（如 playwright） */
export class StdioBridgeMcpClient extends BaseBridgeMcpClient {
  constructor(
    readonly serverName: string,
    private readonly config: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /** 子进程 cwd：传会话工作区，MCP 落盘产物（截图等）才能进文件树 */
      cwd?: string;
    },
  ) {
    super();
  }
  protected async openTransport(): Promise<{
    transport: never;
    closeTransport: () => Promise<void>;
  }> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      ...(this.config.args?.length ? { args: this.config.args } : {}),
      // 缺省继承进程环境（PATH 等），config.env 做增量覆盖——与 codex 旧透传语义一致
      ...(this.config.env && Object.keys(this.config.env).length > 0
        ? { env: { ...process.env, ...this.config.env } as Record<string, string> }
        : {}),
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      stderr: "pipe",
    });
    return { transport: transport as never, closeTransport: () => transport.close() };
  }
}

/** agent 连接器 HTTP MCP server（Streamable HTTP） */
export class HttpBridgeMcpClient extends BaseBridgeMcpClient {
  constructor(
    readonly serverName: string,
    private readonly config: { url: string; headers?: Record<string, string> },
  ) {
    super();
  }
  protected async openTransport(): Promise<{
    transport: never;
    closeTransport: () => Promise<void>;
  }> {
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: {
        ...(this.config.headers && Object.keys(this.config.headers).length > 0
          ? { headers: this.config.headers }
          : {}),
      },
    });
    return { transport: transport as never, closeTransport: () => transport.close() };
  }
}

/** 展平工具名：mcp__<server>__<tool>（与 claude/zcode 引擎的 MCP 工具命名一致） */
export function bridgeToolName(serverName: string, toolName: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${safe(serverName)}__${safe(toolName)}`;
}

/** 门禁检查回调（与 mcp-http-bridge 的 McpGateCheck 同形；命中返回拒绝面，放行返回 undefined） */
export type BridgeGateCheck = (
  toolName: string,
  args: Record<string, unknown>,
) => { gateId: string; summary?: string } | undefined;

export interface BridgeToolExecutorImpl {
  toolDefs(): Promise<Array<{ name: string; description?: string; parameters?: unknown }>>;
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * runner 侧桥执行工具面：聚合全部 MCP 客户端，首用拉取工具清单缓存展平定义；
 * execute 按展平名路由到对应客户端，门禁命中沿用 mcp-http-bridge 同款 fail-closed 文案。
 */
export function createBridgeToolExecutor(
  engineLabel: string,
  entries: Array<{ client: BridgeMcpClient; gateCheck?: BridgeGateCheck }>,
): BridgeToolExecutorImpl {
  let defsCache: Array<{ name: string; description?: string; parameters?: unknown }> | null = null;
  return {
    async toolDefs() {
      if (defsCache) return defsCache;
      const defs: Array<{ name: string; description?: string; parameters?: unknown }> = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        let tools: BridgeMcpToolDef[] = [];
        try {
          tools = await entry.client.listTools();
        } catch (error) {
          // 单服务器不可达不拖垮其余工具面（如 npx 拉包慢/进程起不来）
          console.warn(
            `[bridge-mcp] ${entry.client.serverName} tools/list 失败：${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        for (const tool of tools) {
          const fq = bridgeToolName(entry.client.serverName, tool.name);
          if (seen.has(fq)) continue;
          seen.add(fq);
          defs.push({
            name: fq,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { parameters: tool.inputSchema } : {}),
          });
        }
      }
      defsCache = defs;
      return defs;
    },
    async execute(name: string, args: Record<string, unknown>) {
      const entry = entries.find((e) => name.startsWith(`mcp__${e.client.serverName}__`));
      if (!entry) return `工具不可用：${name}`;
      const prefix = `mcp__${entry.client.serverName}__`;
      const toolName = name.slice(prefix.length);
      if (entry.gateCheck) {
        const gated = entry.gateCheck(name, args);
        if (gated) {
          return `操作被拒绝：${gated.gateId} 门要求人工审批，${engineLabel}引擎会话无交互审批通道（fail-closed）。如需执行请在 Claude 引擎会话中完成。`;
        }
      }
      return entry.client.callTool(toolName, args);
    },
    async close() {
      for (const entry of entries) {
        await entry.client.close().catch(() => undefined);
      }
    },
  };
}
