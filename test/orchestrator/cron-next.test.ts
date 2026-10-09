import { describe, expect, it } from "vitest";
import { nextCronFire, validateCronExpr } from "../../src/orchestrator/cron-next.js";

describe("cron-next", () => {
  it("validateCronExpr：合法与非法边界", () => {
    expect(validateCronExpr("*/5 * * * *")).toBe(true);
    expect(validateCronExpr("0 9 * * 1-5")).toBe(true);
    expect(validateCronExpr("0,30 8-18/2 1,15 * 0")).toBe(true);
    expect(validateCronExpr("60 * * * *")).toBe(false);
    expect(validateCronExpr("* 24 * * *")).toBe(false);
    expect(validateCronExpr("* * 0 * *")).toBe(false);
    expect(validateCronExpr("* * 32 * *")).toBe(false);
    expect(validateCronExpr("* * * 13 *")).toBe(false);
    expect(validateCronExpr("* * * * 8")).toBe(false);
    expect(validateCronExpr("*/0 * * * *")).toBe(false);
    expect(validateCronExpr("1-5 * * *")).toBe(false);
    expect(validateCronExpr("*-* * * * *")).toBe(false);
  });

  it("nextCronFire：分钟级精确命中（本地时区语义，与 node-cron 调度一致）", () => {
    const from = new Date(2026, 9, 9, 10, 0, 30);
    expect(nextCronFire("*/15 * * * *", from)).toBe(new Date(2026, 9, 9, 10, 15).toISOString());
    expect(nextCronFire("0 9 * * *", from)).toBe(new Date(2026, 9, 10, 9, 0).toISOString());
    expect(nextCronFire("5 * * * *", from)).toBe(new Date(2026, 9, 9, 10, 5).toISOString());
  });

  it("nextCronFire：星期/日期列表与 POSIX dom/dow 并集语义", () => {
    // 2026-10-09 是周五（本地）
    const from = new Date(2026, 9, 9, 10, 0, 0);
    expect(nextCronFire("0 8 * * 1", from)).toBe(new Date(2026, 9, 12, 8, 0).toISOString()); // 周一
    expect(nextCronFire("0 8 1 * *", from)).toBe(new Date(2026, 10, 1, 8, 0).toISOString());
    // dom 与 dow 均受限 → 并集（最近者）
    expect(nextCronFire("0 8 10 * 1", from)).toBe(new Date(2026, 9, 10, 8, 0).toISOString()); // 周六=dom 10
    // 7 也表示周日
    expect(nextCronFire("0 8 * * 7", from)).toBe(new Date(2026, 9, 11, 8, 0).toISOString());
  });

  it("nextCronFire：非法表达式返回 null", () => {
    expect(nextCronFire("bad cron")).toBeNull();
  });
});
