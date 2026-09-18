import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import {
  type AuditConversationListItem,
  type AuditDetail,
  fetchAuditConversations,
  fetchAuditDetail,
  formatDateTime,
  formatDurationMs,
  formatTokens,
} from "../lib/audit";
import { cn } from "../lib/utils";

export function AuditPage() {
  const [list, setList] = useState<AuditConversationListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);

  useEffect(() => {
    void fetchAuditConversations()
      .then(setList)
      .catch(() => setList([]));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void fetchAuditDetail(selected)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [selected]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        className="px-7 pt-7"
        title="历史会话审计"
        description="回看每个任务的轮次、事件与 token 消耗"
      />
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-7 pb-7 pt-5">
        {/* 左：会话列表 */}
        <Card className="flex w-80 shrink-0 flex-col overflow-hidden">
          <div className="border-b border-border px-4 py-2.5 text-xs font-semibold text-muted-foreground">
            会话（{list.length}）
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {list.map((c) => (
              <button
                key={c.conversationId}
                type="button"
                onClick={() => setSelected(c.conversationId)}
                className={cn(
                  "mb-0.5 block w-full rounded-lg px-3 py-2 text-left",
                  selected === c.conversationId ? "bg-primary-soft" : "hover:bg-muted",
                )}
              >
                <div
                  className={cn(
                    "truncate text-[13px] font-medium",
                    selected === c.conversationId && "text-primary",
                  )}
                >
                  {c.title || "(无标题)"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {c.turnCount} prompts · {formatTokens(c.totalTokens)} tok ·{" "}
                  {formatDurationMs(c.totalDurationMs)}
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* 右：轮次详情 */}
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto">
          {!detail ? (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
              选择左侧会话查看审计详情
            </div>
          ) : (
            detail.turns.map((t) => {
              const tok = t.usage
                ? t.usage.inputTokens +
                  t.usage.outputTokens +
                  t.usage.cacheCreationInputTokens +
                  t.usage.cacheReadInputTokens
                : undefined;
              return (
                <Card key={t.taskId} className="p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="text-[13px] font-semibold">Turn {t.taskId.slice(0, 8)}</div>
                    <Badge
                      tone={
                        t.status === "done" ? "success" : t.status === "error" ? "danger" : "info"
                      }
                    >
                      {t.status}
                    </Badge>
                  </div>
                  <div className="mb-3 text-[11px] text-muted-foreground">
                    {formatDurationMs(t.durationMs)} · {formatTokens(tok)} tok ·{" "}
                    {formatDateTime(t.createdAt)}
                  </div>
                  <div className="space-y-1.5">
                    {t.events.map((e) => (
                      <EventRow key={e.id} e={e} />
                    ))}
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function EventRow({
  e,
}: {
  e: {
    type: string;
    text?: string;
    toolName?: string;
    toolInput?: string;
    toolOutput?: string;
    isError?: boolean;
    durationMs?: number;
  };
}) {
  if (e.type === "user_message" || e.type === "text") {
    return (
      <div className="whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-[13px] leading-6">
        {e.text}
      </div>
    );
  }
  if (e.type === "tool_use") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-primary-soft/60 px-3 py-2 text-xs">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary text-[10px] text-white">
          ⚙
        </span>
        <span className="font-mono font-medium text-primary">{e.toolName}</span>
        <code className="truncate text-muted-foreground">{e.toolInput}</code>
      </div>
    );
  }
  if (e.type === "tool_result") {
    return (
      <details className="px-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer py-1">
          └ {e.isError ? "❌ " : ""}output · {formatDurationMs(e.durationMs)}
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2">
          {e.toolOutput}
        </pre>
      </details>
    );
  }
  if (e.type === "result") {
    return <div className="px-3 text-xs text-success">✓ result</div>;
  }
  return null;
}
