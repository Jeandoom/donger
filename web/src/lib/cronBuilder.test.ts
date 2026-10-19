import { describe, expect, it } from "vitest";
import {
  buildCron,
  defaultFields,
  defaultPreset,
  describeCron,
  FIELD_META,
  matchPreset,
  parseFieldsFromExpr,
  serializeField,
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
    expect(validateCron("0 9-18/4 * * 1-5")).toBeNull();
  });

  it("每隔 N 小时预设：分钟偏移 + 步进小时", () => {
    const expr = buildCron({ ...defaultPreset(), kind: "everyNHours", nHours: 4, minute: 0 }, defaultFields());
    expect(expr).toBe("0 */4 * * *");
    expect(validateCron(expr)).toBeNull();
    expect(describeCron(expr)).toBe("每 4 小时（第 0 分）");
  });

  it("高级模式 range+step 组合表达工作时段周期（用户场景 9-18 点每 4 小时）", () => {
    const fields: Record<"minute" | "hour" | "dom" | "month" | "dow", FieldState> = {
      ...defaultFields(),
      hour: { type: "range", from: 9, to: 18, step: 4, list: [0] },
      dow: { type: "range", from: 1, to: 5, step: 1, list: [1] },
    };
    const expr = buildCron({ ...defaultPreset(), kind: "custom" }, fields);
    expect(expr).toBe("0 9-18/4 * * 1-5");
    expect(validateCron(expr)).toBeNull();
    expect(describeCron(expr)).toBe("每周一至周五 9-18 点每 4 小时（第 0 分）");
  });

  it("range 单点收敛为单值；range+step 序列化互逆", () => {
    expect(serializeField({ type: "range", from: 5, to: 5, step: 2, list: [] }, 0, 59)).toBe("5");
    expect(serializeField({ type: "range", from: 9, to: 18, step: 4, list: [] }, 0, 23)).toBe(
      "9-18/4",
    );
    expect(serializeField({ type: "range", from: 9, to: 18, step: 1, list: [] }, 0, 23)).toBe(
      "9-18",
    );
  });

  it("表达式 ↔ 五字段 round-trip：解析后重序列化不变", () => {
    const cases = [
      "*/10 * * * *",
      "0 */4 * * *",
      "0 23 * * *",
      "30 8 * * 1,5",
      "15 7 1,15 * *",
      "0 0 1 1 *",
      "0 9-18/4 * * 1-5",
      "0,30 8-18/2 * * 0",
    ];
    for (const expr of cases) {
      const fields = parseFieldsFromExpr(expr);
      expect(fields, expr).not.toBeNull();
      const rebuilt = FIELD_META.map((meta) => serializeField(fields![meta.key], meta.min, meta.max)).join(" ");
      expect(rebuilt, expr).toBe(expr);
    }
  });

  it("matchPreset 反填：常见形态命中预设，复合形态落空走高级", () => {
    expect(matchPreset("*/5 * * * *")).toMatchObject({ kind: "everyNMinutes", n: 5 });
    expect(matchPreset("0 */4 * * *")).toMatchObject({ kind: "everyNHours", nHours: 4 });
    expect(matchPreset("30 * * * *")).toMatchObject({ kind: "hourly", minute: 30 });
    expect(matchPreset("0 23 * * *")).toMatchObject({ kind: "daily", hour: 23 });
    expect(matchPreset("30 8 * * 1,5")).toMatchObject({ kind: "weekly", weekDays: [1, 5] });
    expect(matchPreset("15 7 1,15 * *")).toMatchObject({ kind: "monthly", monthDays: [1, 15] });
    expect(matchPreset("0 0 1 1 *")).toMatchObject({ kind: "yearly", month: 1, monthDay: 1 });
    expect(matchPreset("0 9-18/4 * * 1-5")).toBeNull();
    expect(matchPreset("bad expr")).toBeNull();
  });

  it("describeCron：小时侧范围/步进给中文，其余落自定义", () => {
    expect(describeCron("0 9-18/4 * * *")).toBe("每天 9-18 点每 4 小时（第 0 分）");
    expect(describeCron("0 9-18/4 * * 1-5")).toBe("每周一至周五 9-18 点每 4 小时（第 0 分）");
    expect(describeCron("0 9-18 * * *")).toBe("每天 9-18 点每 1 小时（第 0 分）");
    expect(describeCron("* 9-18/4 * * 1-5")).toBe("自定义"); // 分钟每分钟+窗口：不误报
  });
});
