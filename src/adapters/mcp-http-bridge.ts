import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * 进程内工具台 → Streamable HTTP MCP 桥（codex/zcode 引擎共用）。
 *
 * donger 的 in-process 平台工具台（platform/git/host/kb/audit，Claude SDK 专属形态）
 * 无法直接喂给非 claude 引擎的 CLI；本桥把它们以 Streamable HTTP MCP server 形态挂载
 * （127.0.0.1 随机端口、路径含 run-token 鉴权），供引擎会话以远程 MCP 形态消费——
 * codex 经 config.mcp_servers {url}，zcode 经 session/create mcpServers 参数。
 *
 * 审批门语义：命中审批门的 MCP 写工具在桥内静态拒绝（codex 决策点 ①A fail-closed）——
 * 这类引擎会话内无人工审批通道。gateCheck 由各 runner 注入，可读会话权限模式分流
 * （zcode：force 门恒拒、非 force 门 full_access 放行；codex：命中即拒）。
 */

/** in-process MCP server 实例的最小结构面（Claude SDK createSdkMcpServer 产物即满足） */
export interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close?(): Promise<void>;
}

/** 审批门检查回调：返回命中的 gateId/force 或 undefined（复用 GateRouter.match 语义） */
export type McpGateCheck = (
  tool: string,
  input: Record<string, unknown>,
) => { gateId: string; force?: boolean } | undefined;

interface McpMount {
  runToken: string;
  serverName: string;
  transport: StreamableHTTPServerTransport;
  gateCheck?: McpGateCheck;
}

export const MAX_MCP_BODY_BYTES = 64 * 1024 * 1024;

export class McpHttpBridge {
  private server: Server | null = null;
  private startPromise: Promise<number> | null = null;
  private readonly mounts = new Map<string, McpMount>();

  /** 静态拒绝文案里的引擎标识（如 "OpenAI"/"ZCode"） */
  constructor(private readonly engineLabel: string) {}

  /** 懒启动：绑定 127.0.0.1 随机端口，返回端口号（幂等） */
  ensureStarted(): Promise<number> {
    if (this.port()) return Promise.resolve(this.port() as number);
    if (!this.startPromise) {
      this.startPromise = new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
          void this.handle(req, res).catch((error: unknown) => {
            if (!res.headersSent) {
              res.writeHead(500, { "content-type": "application/json" });
            }
            res.end(JSON.stringify({ error: { message: String(error) } }));
          });
        });
        server.requestTimeout = 0;
        server.headersTimeout = 30_000;
        server.on("error", (error) => {
          this.startPromise = null;
          this.server = null;
          reject(error);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("mcp bridge listen 失败：非法地址"));
            return;
          }
          this.server = server;
          resolve(address.port);
        });
      });
    }
    return this.startPromise;
  }

  private port(): number | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : null;
  }

  /**
   * 把 in-process MCP server 实例挂载为 Streamable HTTP MCP 端点（stateless 模式），
   * 路径含 run-token 鉴权。返回给引擎 MCP 配置用的完整 URL。
   */
  async mountMcp(
    runToken: string,
    serverName: string,
    instance: McpServerLike,
    gateCheck?: McpGateCheck,
  ): Promise<string> {
    const port = await this.ensureStarted();
    // stateful 会话模式：initialize 发 mcp-session-id，后续请求凭会话路由
    //（stateless 模式要求每请求新建 transport+实例，per-run 挂载不适用）
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await instance.connect(transport as never);
    this.mounts.set(mcpMountKey(runToken, serverName), {
      runToken,
      serverName,
      transport,
      gateCheck,
    });
    return `http://127.0.0.1:${port}/mcp/${runToken}/${serverName}`;
  }

  /** 运行结束卸载该 run 的全部挂载（transport 关闭；实例为 per-run 构造，随后自然 GC） */
  async unmountAllMcp(runToken: string): Promise<void> {
    for (const [key, mount] of [...this.mounts.entries()]) {
      if (mount.runToken !== runToken) continue;
      this.mounts.delete(key);
      try {
        await mount.transport.close();
      } catch {
        // 已断开/重复关闭忽略
      }
    }
  }

  mcpMountCountForTests(): number {
    return this.mounts.size;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    for (const key of [...this.mounts.keys()]) this.mounts.delete(key);
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    if (!url.startsWith("/mcp/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    await this.handleMcp(req, res, url);
  }

  /** MCP 挂载请求处理：审批门拦截 tools/call，其余透传 StreamableHTTP transport */
  private async handleMcp(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    // /mcp/<runToken>/<serverName>
    const rest = url.slice("/mcp/".length);
    const slash = rest.indexOf("/");
    const runToken = slash > 0 ? rest.slice(0, slash) : "";
    const serverName = slash > 0 ? decodeURIComponent(rest.slice(slash + 1)) : "";
    const mount = this.mounts.get(mcpMountKey(runToken, serverName));
    if (!mount) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mcp mount not found" } }));
      return;
    }

    if (req.method !== "POST") {
      // stateless 模式无服务端主动推送：GET/DELETE 交 transport 处理（其会回 405）
      await mount.transport.handleRequest(req, res).catch(() => {});
      return;
    }

    const body = await readBody(req);
    let parsed: JsonRecord;
    try {
      parsed = JSON.parse(body.toString("utf8")) as JsonRecord;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json body" } }));
      return;
    }

    // 审批门静态拒绝（决策点 ①A）：git-write/authoring/host-ops 等写工具在无人工
    // 通道的引擎会话 fail-closed，工具实现不执行
    if (parsed.method === "tools/call" && mount.gateCheck) {
      const params = (parsed.params ?? {}) as JsonRecord;
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const gated = mount.gateCheck(`mcp__${mount.serverName}__${toolName}`, args);
      if (gated) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text: `操作被拒绝：${gated.gateId} 门要求人工审批，${this.engineLabel}引擎会话无交互审批通道（fail-closed）。如需执行请在 Claude 引擎会话中完成。`,
                },
              ],
              isError: true,
            },
          }),
        );
        return;
      }
    }

    await mount.transport.handleRequest(req, res, parsed).catch(() => {});
  }
}

function mcpMountKey(runToken: string, serverName: string): string {
  return `${runToken}/${serverName}`;
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_MCP_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

type JsonRecord = Record<string, unknown>;
