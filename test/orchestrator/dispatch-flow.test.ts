import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDispatcherAgent } from "../../src/orchestrator/dispatch-flow.js";

const KB_DIR = "/tmp/ws/kb";

describe("buildDispatcherAgent", () => {
  it("知识库以只读扩展目录注入，工具只读白名单", () => {
    const agent = buildDispatcherAgent(KB_DIR);
    expect(agent.id).toBe("builtin-dispatcher");
    expect(agent.skills).toEqual(["task-dispatch"]);
    expect(agent.tools).toEqual({ mode: "whitelist", whitelist: ["Read", "Glob"] });
    expect(agent.extensionDirectories).toEqual([
      {
        id: "kb-dispatcher",
        name: "任务管理知识库",
        path: join(KB_DIR, "dispatcher"),
        access: "readOnly",
      },
    ]);
  });
});

// 注：dispatchTask 已退役，dispatcher 轮走 Orchestrator.runDispatcherTurn（统一 turn 管道）。
// 编排行为（路由命中/noResume/DISPATCH_FAILED 转译）由 test/orchestrator/orchestrator-phases.test.ts
// 与 orchestrator-queue.test.ts 在 handleMessage 层覆盖。
