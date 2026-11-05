import { describe, expect, it } from "vitest";
import { DevServerError } from "../../src/orchestrator/dev-server-service.js";
import {
  devServerToolDefinitions,
  type DevServerToolsDeps,
} from "../../src/orchestrator/dev-server-tools.js";
import type { DevServerHandle } from "../../src/orchestrator/dev-server-service.js";

/** dev_* 工具契约：写边界（根目录/会话）闭包绑定、越界拒绝、服务错误透传为 isError */

function makeDeps(overrides?: Partial<DevServerToolsDeps>) {
  const calls: Array<Record<string, unknown>> = [];
  const deps: DevServerToolsDeps = {
    conversationId: "conv-1",
    ownerId: "user-1",
    agentId: "agent-1",
    root: "/tmp/project-root",
    service: {
      start: async (req) => {
        calls.push({ op: "start", req });
        const handle: DevServerHandle = {
          conversationId: req.conversationId,
          port: 30001,
          url: `/preview/${req.conversationId}/`,
          reused: false,
        };
        return handle;
      },
      status: async () => undefined,
      logs: () => [],
      stop: async () => false,
      resolveUpstream: async () => null,
      touch: async () => undefined,
    } as unknown as DevServerToolsDeps["service"],
    ...overrides,
  };
  return { deps, calls };
}

function tool(deps: DevServerToolsDeps, name: string) {
  const def = devServerToolDefinitions(deps).find((t) => t.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return def;
}

describe("dev-server 工具", () => {
  it("dev_start：透传会话/属主/根目录闭包绑定，返回预览地址", async () => {
    const { deps, calls } = makeDeps();
    const result = await tool(deps, "dev_start").handler({} as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).toContain("/preview/conv-1/");
    expect(calls[0]).toMatchObject({
      op: "start",
      req: { conversationId: "conv-1", ownerId: "user-1", agentId: "agent-1", cwd: "/tmp/project-root" },
    });
  });

  it("dev_start：目录穿越越界拒绝", async () => {
    const { deps, calls } = makeDeps();
    const result = await tool(deps, "dev_start").handler({ dir: "../elsewhere" } as never);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("越界");
    expect(calls).toEqual([]);
  });

  it("dev_start：服务错误（上限/排水/未就绪）透传消息与日志尾", async () => {
    const { deps } = makeDeps({
      service: {
        start: async () => {
          throw new DevServerError("limit_total", "平台 dev server 并发已达上限（4/4）", {
            logs: ["$ npm run dev", "[exit code=1]"],
          });
        },
        status: async () => undefined,
        logs: () => [],
        stop: async () => false,
        resolveUpstream: async () => null,
        touch: async () => undefined,
      } as unknown as DevServerToolsDeps["service"],
    });
    const result = await tool(deps, "dev_start").handler({} as never);
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain("并发已达上限");
    expect(text).toContain("npm run dev");
  });

  it("dev_status/dev_logs/dev_stop 语义", async () => {
    const { deps } = makeDeps();
    expect(JSON.stringify(await tool(deps, "dev_status").handler({} as never))).toContain("未运行");
    expect(JSON.stringify(await tool(deps, "dev_logs").handler({} as never))).toContain("无日志");
    const stop = await tool(deps, "dev_stop").handler({} as never);
    expect(stop.isError).toBe(true);
    expect(JSON.stringify(stop)).toContain("未在运行");
  });
});
