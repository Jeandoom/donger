import { describe, expect, it } from "vitest";
import { groupNotificationsByTitle, type NotificationItem } from "./notifications";

function item(partial: Partial<NotificationItem> & { id: string }): NotificationItem {
  return {
    event: "workflow.run_succeeded",
    severity: "info",
    title: "t",
    body: "b",
    createdAt: "2026-11-05T00:00:00.000Z",
    ...partial,
  };
}

describe("groupNotificationsByTitle", () => {
  it("同标题合并为一条并计数，latest 取组内最新", () => {
    const rows = groupNotificationsByTitle([
      item({ id: "1", title: "「X」执行成功", createdAt: "2026-11-05T01:00:00.000Z" }),
      item({ id: "2", title: "「X」执行成功", createdAt: "2026-11-05T03:00:00.000Z" }),
      item({ id: "3", title: "「X」执行成功", createdAt: "2026-11-05T02:00:00.000Z" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("「X」执行成功");
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.latest.id).toBe("2");
  });

  it("不同标题各自成组，组按最新时间倒序", () => {
    const rows = groupNotificationsByTitle([
      item({ id: "1", title: "A", createdAt: "2026-11-05T01:00:00.000Z" }),
      item({ id: "2", title: "B", createdAt: "2026-11-05T05:00:00.000Z" }),
      item({ id: "3", title: "A", createdAt: "2026-11-05T02:00:00.000Z" }),
    ]);
    expect(rows.map((r) => [r.title, r.count])).toEqual([
      ["B", 1],
      ["A", 2],
    ]);
    expect(rows[1]?.latest.id).toBe("3");
  });

  it("标题精确匹配：相近但不相同的标题不合并", () => {
    const rows = groupNotificationsByTitle([
      item({ id: "1", title: "「A」执行成功" }),
      item({ id: "2", title: "「A」执行失败" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("空列表返回空", () => {
    expect(groupNotificationsByTitle([])).toEqual([]);
  });
});
