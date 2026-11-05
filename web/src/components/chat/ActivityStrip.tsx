import { AlertTriangle, ChevronDown, Loader2, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatActivityLine } from "../../lib/activityLine";
import { cn } from "../../lib/utils";

/**
 * 执行活动条 v2（chat UE 优化轮 E2-A 重设计）：单行状态 pill（与 JumpToBottom 同设计语言）——
 * spinner + 最新一行（工具显示名+参数摘要，失败行 destructive 图标）+ 历史计数，
 * 点击向上展开干净的历史列表（替代旧版裸文本滚动框：无裁切、无原始 JSON 直出）。
 * 回合收口即消失（完成的工具调用以回合内 ToolCard 呈现）。
 */
export function ActivityStrip({
  lines,
  queueDepth,
  running,
  className,
  defaultExpanded = false,
}: {
  lines: string[];
  queueDepth: number;
  running: boolean;
  className?: string;
  /** 预览/测试用：初始展开历史 */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listRef = useRef<HTMLDivElement | null>(null);
  const visible = running && (lines.length > 0 || queueDepth > 0);
  const latest = lines[lines.length - 1] ?? "";
  const latestView = useMemo(() => formatActivityLine(latest), [latest]);
  const earlierCount = Math.max(0, lines.length - 1);

  // 展开时贴底（最新一行在视野内）
  useEffect(() => {
    if (expanded && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [expanded, lines.length]);

  if (!visible) return null;
  return (
    <div
      className={cn(
        "mx-auto mb-2 flex w-full max-w-3xl items-center justify-between gap-2 px-1",
        className,
      )}
      role="status"
      aria-label="执行活动"
    >
      {lines.length > 0 ? (
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={expanded}
            title={expanded ? "收起活动历史" : "展开活动历史"}
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "flex h-9 max-w-full items-center gap-2 rounded-full border px-3 text-xs shadow-sm backdrop-blur",
              "border-border/70 bg-card/90 transition-colors hover:bg-muted",
              latestView.kind === "error" && "border-destructive/30 bg-destructive-soft/80",
            )}
          >
            {latestView.kind === "error" ? (
              <AlertTriangle size={12} className="shrink-0 text-destructive" aria-hidden="true" />
            ) : (
              <Loader2
                size={12}
                className="shrink-0 animate-spin text-primary"
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                "shrink-0 font-medium",
                latestView.kind === "error" ? "text-destructive" : "text-foreground/85",
              )}
            >
              {latestView.label}
            </span>
            {latestView.detail ? (
              <span className="min-w-0 truncate font-mono opacity-60">{latestView.detail}</span>
            ) : null}
            {earlierCount > 0 ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                +{earlierCount}
              </span>
            ) : null}
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={cn(
                "shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-180",
              )}
            />
          </button>
          {expanded ? (
            <div
              ref={listRef}
              className="absolute bottom-full left-0 z-20 mb-1.5 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg"
            >
              {lines.map((line, i) => {
                const view = formatActivityLine(line);
                const isLatest = i === lines.length - 1;
                return (
                  <div
                    key={`${i}:${line}`}
                    className={cn(
                      "flex items-start gap-2 rounded-lg px-2 py-1 text-xs",
                      isLatest && "bg-muted",
                    )}
                  >
                    {view.kind === "error" ? (
                      <AlertTriangle
                        size={11}
                        className="mt-0.5 shrink-0 text-destructive"
                        aria-hidden="true"
                      />
                    ) : view.kind === "tool" ? (
                      <Wrench
                        size={11}
                        className="mt-0.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40"
                      />
                    )}
                    <span className="min-w-0 flex-1 break-words">
                      <span
                        className={cn(
                          "font-medium",
                          view.kind === "error" ? "text-destructive" : "text-foreground/85",
                        )}
                      >
                        {view.label}
                      </span>
                      {view.detail ? (
                        <span className="ml-1.5 font-mono opacity-60">{view.detail}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {queueDepth > 0 ? (
        <span
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-info/30 bg-info-soft px-3 text-xs font-medium text-info-foreground"
          title="当前任务完成后将自动依序处理排队消息"
        >
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          排队中 · 第 {queueDepth} 位
        </span>
      ) : null}
    </div>
  );
}
