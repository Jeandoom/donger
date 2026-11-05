import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 执行活动条（chat UE 优化轮 E2-A）：消费既有 activity SSE（工具摘要行）+ queue_depth。
 * 运行中钉在 composer 上方常驻可见（浏览历史时也不丢过程感）；回合收口即消失
 * （完成的工具调用在回合内以 ToolCard 呈现，此处只承载「正在发生什么」）。
 */
export function ActivityStrip({
  lines,
  queueDepth,
  running,
  className,
}: {
  lines: string[];
  queueDepth: number;
  running: boolean;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const visible = running && (lines.length > 0 || queueDepth > 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 贴底仅需响应行数变化（行内容不回写）
  useEffect(() => {
    // 新活动行到达时贴底（滚窗最新行在视野内）
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines.length]);

  if (!visible) return null;
  return (
    <div
      className={cn(
        "mx-auto mb-2 flex w-full max-w-3xl items-end justify-between gap-2 px-1 text-xs",
        className,
      )}
      role="status"
      aria-label="执行活动"
    >
      {lines.length > 0 ? (
        <div
          ref={boxRef}
          className="max-h-16 min-w-0 flex-1 overflow-y-auto rounded-xl border border-border/70 bg-card/80 px-2.5 py-1.5 text-muted-foreground"
        >
          {lines.slice(-6).map((line, i, arr) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 滚窗摘要行可能重复，需序号消歧
              key={`${i}:${line}`}
              className={cn("truncate", i === arr.length - 1 && "font-medium text-foreground/80")}
            >
              {line}
            </div>
          ))}
        </div>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {queueDepth > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 font-medium text-info-foreground"
          title="当前任务完成后将自动依序处理排队消息"
        >
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          排队中 · 第 {queueDepth} 位
        </span>
      ) : null}
    </div>
  );
}
