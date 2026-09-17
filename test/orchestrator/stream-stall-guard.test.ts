import { describe, expect, it, vi } from "vitest";
import type { RunnerEvent } from "../../src/domain/types.js";
import { guardStreamStall } from "../../src/orchestrator/stream-stall-guard.js";

async function* slowEvents(delays: Array<number | "stall">): AsyncGenerator<RunnerEvent> {
  for (const d of delays) {
    if (d === "stall") await new Promise((r) => setTimeout(r, 1_000));
    else await new Promise((r) => setTimeout(r, d));
    yield { type: "text", taskId: "t", text: "x" };
  }
}

describe("guardStreamStall", () => {
  it("事件间隔小于阈值：正常透传不拦截", async () => {
    const onStall = vi.fn();
    const out: RunnerEvent[] = [];
    for await (const e of guardStreamStall(slowEvents([1, 1, 1]), 500, onStall)) out.push(e);
    expect(out).toHaveLength(3);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("事件间隔超过阈值：调用 onStall 并抛错", async () => {
    const onStall = vi.fn();
    const iter = guardStreamStall(slowEvents([1, "stall"]), 100, onStall);
    await expect(async () => {
      for await (const _e of iter) {
        // 消费第一个事件后，第二个事件停摆超阈值
      }
    }).rejects.toThrow(/长时间无进展/);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("流正常结束不误报", async () => {
    const onStall = vi.fn();
    const out: RunnerEvent[] = [];
    for await (const e of guardStreamStall(slowEvents([1]), 500, onStall)) out.push(e);
    expect(out).toHaveLength(1);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("豁免生效（等待用户输入）：停摆到期不拦截，流恢复后继续消费", async () => {
    const onStall = vi.fn();
    const out: RunnerEvent[] = [];
    // 第二个事件慢 1000ms（> 100ms 阈值），但全程豁免（等待用户输入）
    for await (const e of guardStreamStall(slowEvents([1, "stall"]), 100, onStall, () => true)) {
      out.push(e);
    }
    expect(out).toHaveLength(2);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("豁免解除后：停摆到期恢复拦截", async () => {
    const onStall = vi.fn();
    const exempt = { on: true };
    const iter = guardStreamStall(slowEvents([1, "stall"]), 100, onStall, () => exempt.on);
    await expect(async () => {
      for await (const _e of iter) {
        exempt.on = false; // 消费第一个事件后解除豁免（模拟问询已 settle）
      }
    }).rejects.toThrow(/长时间无进展/);
    expect(onStall).toHaveBeenCalledTimes(1);
  });
});
