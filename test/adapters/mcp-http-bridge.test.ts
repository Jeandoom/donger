import { afterEach, describe, expect, it } from "vitest";
import { McpHttpBridge } from "../../src/adapters/mcp-http-bridge.js";

/** 共享 MCP HTTP 桥回环（真实 MCP 客户端）：codex-chat-bridge.test.ts 同款三件 +
 *  引擎文案标识与卸载生命周期。zcode/codex 两引擎的 MCP 挂载都落在这层。 */
describe("McpHttpBridge（真实 MCP 客户端回环）", () => {
  const bridges: McpHttpBridge[] = [];

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.close();
  });

  async function mountTestServer(options?: {
    engineLabel?: string;
    gateCheck?: Parameters<McpHttpBridge["mountMcp"]>[3];
  }) {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { z } = await import("zod");
    const bridge = new McpHttpBridge(options?.engineLabel ?? "ZCode");
    bridges.push(bridge);
    const instance = new McpServer({ name: "donger-test", version: "1.0.0" });
    instance.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async ({ text }: { text: string }) => ({ content: [{ type: "text", text }] }),
    );
    instance.registerTool("danger_write", { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "不应到达" }],
    }));
    const url = await bridge.mountMcp(
      "run-tok",
      "donger-test",
      instance as never,
      options?.gateCheck,
    );
    return { bridge, url };
  }

  it("tools/list + tools/call 全链路", async () => {
    const { url } = await mountTestServer();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["echo", "danger_write"]),
    );
    const result = await client.callTool({ name: "echo", arguments: { text: "ping" } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "ping" }] });
    await client.close();
  });

  it("审批门命中 → isError 拒绝结果，文案带 gateId 与引擎标识，工具实现不执行", async () => {
    const { url } = await mountTestServer({
      engineLabel: "ZCode",
      gateCheck: (tool) =>
        tool === "mcp__donger-test__danger_write" ? { gateId: "host-ops", force: true } : undefined,
    });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const denied = (await client.callTool({ name: "danger_write", arguments: {} })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(denied.isError).toBe(true);
    expect(denied.content?.[0]?.text).toContain("host-ops");
    expect(denied.content?.[0]?.text).toContain("ZCode");
    const allowed = await client.callTool({ name: "echo", arguments: { text: "fine" } });
    expect(allowed).toMatchObject({ content: [{ type: "text", text: "fine" }] });
    await client.close();
  });

  it("未知 run-token 的挂载路径 404", async () => {
    const { bridge } = await mountTestServer();
    const port = await bridge.ensureStarted();
    const response = await fetch(`http://127.0.0.1:${port}/mcp/wrong-token/donger-test`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
  });

  it("unmountAllMcp 按 run-token 卸载，其余挂载不受影响", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const bridge = new McpHttpBridge("ZCode");
    bridges.push(bridge);
    const makeInstance = async (name: string) => {
      const instance = new McpServer({ name, version: "1.0.0" });
      instance.registerTool("ping", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      return instance;
    };
    await bridge.mountMcp("run-a", "server-a", (await makeInstance("a")) as never);
    await bridge.mountMcp("run-b", "server-b", (await makeInstance("b")) as never);
    expect(bridge.mcpMountCountForTests()).toBe(2);
    await bridge.unmountAllMcp("run-a");
    expect(bridge.mcpMountCountForTests()).toBe(1);
    await bridge.unmountAllMcp("run-a");
    expect(bridge.mcpMountCountForTests()).toBe(1);
  });
});
