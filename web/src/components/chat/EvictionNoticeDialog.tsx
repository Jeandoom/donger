import { TriangleAlert } from "lucide-react";
import type { EvictionNotice } from "../../types";
import { Button } from "../ui/button";

export interface EvictionNoticeDialogProps {
  notice: EvictionNotice | null;
  onClose: () => void;
}

/** 时间格式化：ISO → 本地可读（无有效值显示 -） */
function fmt(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 并发淘汰弹窗：并发满载时系统强制结束最早挂起的任务放行新任务，
 * 本弹窗把被结束任务的详情（内容摘要 + 三个时间点）告知用户，便于同步信息。
 */
export function EvictionNoticeDialog({ notice, onClose }: EvictionNoticeDialogProps) {
  if (!notice) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="任务被自动结束通知"
    >
      <div className="w-full max-w-md rounded-xl border border-warning/50 bg-card p-5 shadow-xl">
        <div className="flex items-center gap-2 text-base font-semibold text-warning-foreground">
          <TriangleAlert size={16} aria-hidden="true" />
          一个等待中的任务已被自动结束
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          您的并发对话已达上限（10 条）。为执行新任务，系统结束了最早进入等待状态的任务。
          被结束的任务信息如下：
        </p>
        <dl className="mt-3 space-y-1.5 rounded-lg bg-warning-soft p-3 text-sm">
          <div>
            <dt className="inline font-medium text-warning-foreground">任务内容：</dt>
            <dd className="inline break-all text-warning-foreground">{notice.taskExcerpt}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-warning-foreground">所属会话：</dt>
            <dd className="inline break-all text-warning-foreground">{notice.conversationId}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-warning-foreground">开始时间：</dt>
            <dd className="inline text-warning-foreground">{fmt(notice.startedAt)}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-warning-foreground">进入等待：</dt>
            <dd className="inline text-warning-foreground">{fmt(notice.pendingSince)}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-warning-foreground">结束时间：</dt>
            <dd className="inline text-warning-foreground">{fmt(notice.canceledAt)}</dd>
          </div>
        </dl>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={onClose}>
            我知道了
          </Button>
        </div>
      </div>
    </div>
  );
}
