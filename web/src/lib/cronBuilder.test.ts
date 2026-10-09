import { describe, expect, it } from "vitest";
import {
  buildCron,
  defaultFields,
  defaultPreset,
  describeCron,
  validateCron,
  type FieldState,
} from "./cronBuilder";

describe("cronBuilder", () => {
  it("预设模式生成标准 5 段表达式且全部自校验通过", () => {
    const fields = defaultFields();
    const cases: Array<[Parameters<typeof buildCron>[0], string, string]> = [
      [{ ...defaultPreset(), kind: "everyNMinutes", n: 5 }, "*/5 * * * *", "每 5 分钟"],
      [{ ...defaultPreset(), kind: "hourly", minute: 30 }, "30 * * * *", "每小时第 30 分"],
      [{ ...defaultPreset(), kind: "daily", hour: 9, minute: 0 }, "0 9 * * *", "每天 09:00"],
      [
        { ...defaultPreset(), kind: "weekly", weekDays: [1, 5], hour: 8, minute: 30 },
        "30 8 * * 1,5",
        "每周一、周五 08:30",
      ],
      [
        { ...defaultPreset(), kind: "monthly", monthDays: [1, 15], hour: 7, minute: 15 },
        "15 7 1,15 * *",
        "每月1 号、15 号 07:15",
      ],
      [
        { ...defaultPreset(), kind: "yearly", month: 1, monthDay: 1, hour: 0, minute: 0 },
        "0 0 1 1 *",
        "每年 1 月 1 日 00:00",
      ],
    ];
    for (const [preset, expectedExpr, expectedDesc] of cases) {
      const expr = buildCron(preset, fields);
      expect(expr).toBe(expectedExpr);
      expect(validateCron(expr)).toBeNull();
      expect(describeCron(expr)).toBe(expectedDesc);
    }
  });

  it("高级模式四模式序列化覆盖范围/步进/列表", () => {
    const fields: Record<"minute" | "hour" | "dom" | "month" | "dow", FieldState> = {
      ...defaultFields(),
      minute: { type: "step", from: 0, to: 59, step: 10, list: [0] },
      hour: { type: "range", from: 8, to: 18, step: 1, list: [0] },
      dom: { type: "list", from: 1, to: 31, step: 1, list: [1, 15, 20] },
      month: { type: "every", from: 1, to: 12, step: 1, list: [1] },
      dow: { type: "every", from: 0, to: 7, step: 1, list: [1] },
    };
    const expr = buildCron({ ...defaultPreset(), kind: "custom" }, fields);
    expect(expr).toBe("*/10 8-18 1,15,20 * *");
    expect(validateCron(expr)).toBeNull();
  });

  it("validateCron 与后端同构：非法组合被拒", () => {
    expect(validateCron("60 * * * *")).toContain("第 1 段");
    expect(validateCron("* * *")).toContain("5 段");
    expect(validateCron("0 9 * *")).toContain("5 段");
    expect(validateCron("0 9 * * *")).toBeNull();
  });
});
