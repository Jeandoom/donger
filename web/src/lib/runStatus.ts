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

export function runStatusTone(status: string): "info" | "success" | "danger" | "neutral" {
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
  system: "系统",
};

export function eventNameLabel(name: string): string {
  return EVENT_NAME_LABEL[name] ?? name;
}

/** 相对时间口径（卡片折叠行）：刚刚 / N 分钟前 / N 小时前，更久落日期 */
export function relativeTime(iso?: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString();
}

/** 执行耗时（started→finished；未结束按现在算） */
export function runDurationText(startedAt?: string | null, finishedAt?: string | null): string {
  if (!startedAt) return "—";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const ms = Math.max(0, end - Date.parse(startedAt));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
