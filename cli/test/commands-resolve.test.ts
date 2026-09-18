import { describe, expect, it } from "vitest";
import { resolveId } from "../src/commands.js";

const T1 = {
  id: "dc39ecc5-aaaa-bbbb-cccc-dddddddd0001",
  createdAt: "2026-09-08T01:00:00Z",
  prompt: "任务一",
};
const T2 = {
  id: "dc39ecc5-aaaa-bbbb-cccc-dddddddd0002",
  createdAt: "2026-09-08T02:00:00Z",
  prompt: "任务二",
};
const T3 = {
  id: "ef123456-aaaa-bbbb-cccc-dddddddd0003",
  createdAt: "2026-09-08T03:00:00Z",
  prompt: "任务三",
};

describe("resolveId（短 id 前缀解析）", () => {
  it("完整 UUID 直通（不查询）", async () => {
    let called = false;
    const full = "dc39ecc5-aaaa-bbbb-cccc-dddddddd0001";
    const r = await resolveId(
      full,
      async () => {
        called = true;
        return [T1];
      },
      "任务",
      "tasks list",
    );
    expect(r).toBe(full);
    expect(called).toBe(false);
  });

  it("唯一命中 → 返回完整 id", async () => {
    const r = await resolveId("ef12", async () => [T1, T2, T3], "任务", "tasks list");
    expect(r).toBe(T3.id);
  });

  it("零命中 → 报错并提示查看列表", async () => {
    await expect(resolveId("zzzz", async () => [T1], "任务", "tasks list")).rejects.toThrow(
      /未找到匹配的任务.*tasks list/s,
    );
  });

  it("多命中 → 报错并列出候选（按创建时间倒序）", async () => {
    await expect(resolveId("dc39ecc5", async () => [T1, T2], "任务", "tasks list")).rejects.toThrow(
      /匹配 2 条.*dc39ecc5-aaaa-bbbb-cccc-dddddddd0002.*任务二/s,
    );
  });
});
