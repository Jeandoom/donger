import { describe, expect, it } from "vitest";
import { EventInputSchema } from "../../src/domain/event.js";

const scheduleBase = {
  name: "定时",
  type: "schedule",
  schedule: { cron: "0 9 * * *", mode: "unconditional" },
};

describe("EventInputSchema cron 语法门", () => {
  it("标准 5 段表达式全部放行（含范围+步进复合）", () => {
    for (const cron of [
      "*/5 * * * *",
      "0 23 * * *",
      "0 9-18/4 * * 1-5",
      "0 */4 * * *",
      "30 8-18/2 * * 1,3,5",
      "0,30 8 1,15 * *",
    ]) {
      const r = EventInputSchema.safeParse({
        ...scheduleBase,
        schedule: { cron, mode: "unconditional" },
      });
      expect(r.success, `${cron} 应合法`).toBe(true);
    }
  });

  it("语法错表达式保存即拒（过去会静默入库且永不触发）", () => {
    for (const cron of ["0 25 * * *", "61 * * * *", "* * *", "@daily", "0 9 * * * *"]) {
      const r = EventInputSchema.safeParse({
        ...scheduleBase,
        schedule: { cron, mode: "unconditional" },
      });
      expect(r.success, `${cron} 应非法`).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.message).toContain("cron 表达式非法");
      }
    }
  });

  it("纯定时缺 source/matcher 仍合法；有条件缺 source 仍被类型 refine 拒", () => {
    expect(
      EventInputSchema.safeParse({
        ...scheduleBase,
        schedule: { cron: "0 9 * * *", mode: "unconditional" },
      }).success,
    ).toBe(true);
    expect(
      EventInputSchema.safeParse({
        ...scheduleBase,
        schedule: { cron: "0 9 * * *", mode: "conditional" },
      }).success,
    ).toBe(false);
  });
});

describe("EventInputSchema message 类型（spec 2026-10-27 §4.2 D1）", () => {
  const messageBase = { name: "群消息订阅", type: "message" };

  it("合法 message 配置放行（filter/matcher 可省）", () => {
    expect(
      EventInputSchema.safeParse({
        ...messageBase,
        message: { platform: "dingtalk", topic: "robot.group" },
      }).success,
    ).toBe(true);
    expect(
      EventInputSchema.safeParse({
        ...messageBase,
        message: {
          platform: "dingtalk",
          topic: "robot.group",
          filter: { openConversationId: "cid-1", allowFrom: ["staff-1"] },
          matcher: { kind: "bodyContains", keyword: "库存" },
        },
      }).success,
    ).toBe(true);
  });

  it("缺 message 配置拒；非法 platform 拒；topic 超长拒", () => {
    expect(EventInputSchema.safeParse({ ...messageBase }).success).toBe(false);
    expect(
      EventInputSchema.safeParse({
        ...messageBase,
        message: { platform: "wechat", topic: "robot.group" },
      }).success,
    ).toBe(false);
    expect(
      EventInputSchema.safeParse({
        ...messageBase,
        message: { platform: "dingtalk", topic: "x".repeat(129) },
      }).success,
    ).toBe(false);
  });

  it("type=message 但提供的是其他类型配置 → refine 拒", () => {
    expect(EventInputSchema.safeParse({ ...messageBase, call: { path: "/hooks/x" } }).success).toBe(
      false,
    );
  });
});
