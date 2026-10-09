/** 执行记录状态展示口径（前端统一） */
export function runStatusLabel(status: string): string {
  const map: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    success: "成功",
    failed: "失败",
    stopped: "已停止",
  };
  return map[status] ?? status;
}

export function runStatusTone(
  status: string,
): "info" | "success" | "danger" | "neutral" {
  const map: Record<string, "info" | "success" | "danger" | "neutral"> = {
    queued: "info",
    running: "info",
    success: "success",
    failed: "danger",
    stopped: "neutral",
  };
  return map[status] ?? "neutral";
}

export const EVENT_NAME_LABEL: Record<string, string> = {
  manual: "手动",
  schedule: "定时",
  call: "调用",
};

export function eventNameLabel(name: string): string {
  return EVENT_NAME_LABEL[name] ?? name;
}
