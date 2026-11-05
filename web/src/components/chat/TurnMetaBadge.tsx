import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { TurnUsage } from "../../types";

/**
 * 回合徽标行（chat UE 优化轮 E2-B）：模型 · token · 耗时 · 停止/失败注记。
 * 数据源：实时轮随 SSE result.usage 到达；历史回合来自 events 回放的 audit result 行。
 * 全部可选——缺数据时整体不渲染（旧数据/引擎未回传），不占版面。
 */

function formatTokens(n: number | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

export function TurnMetaBadge({
  meta,
  stopped,
  isError,
  className,
}: {
  meta?: TurnUsage;
  stopped?: boolean;
  isError?: boolean;
  className?: string;
}) {
  const inTok = formatTokens(meta?.inputTokens);
  const outTok = formatTokens(meta?.outputTokens);
  const duration = formatDuration(meta?.durationMs);
  const model = meta?.model;
  if (!model && !inTok && !outTok && !duration && !stopped && !isError) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {stopped ? (
        <span className="rounded bg-warning-soft px-1 py-px font-medium text-warning-foreground">
          已停止
        </span>
      ) : isError ? (
        <span className="rounded bg-destructive-soft px-1 py-px font-medium text-destructive">
          出错
        </span>
      ) : null}
      {model ? (
        <span
          className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-px font-normal"
          title={`本轮模型：${model}`}
        >
          <Loader2 size={9} className="text-muted-foreground" aria-hidden="true" />
          {model}
        </span>
      ) : null}
      {inTok || outTok ? (
        <span className="font-normal" title="本轮 token 用量（↑ 输入 / ↓ 输出）">
          {inTok ? <span>↑{inTok}</span> : null}
          {inTok && outTok ? <span> </span> : null}
          {outTok ? <span>↓{outTok}</span> : null}
        </span>
      ) : null}
      {duration ? <span className="font-normal">{duration}</span> : null}
    </span>
  );
}
