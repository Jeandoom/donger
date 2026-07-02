import { useEffect, useState } from "react";
import {
  type AuditConversationListItem,
  type AuditDetail,
  fetchAuditConversations,
  fetchAuditDetail,
  formatDurationMs,
  formatTokens,
} from "../lib/audit";

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
    <div className="flex h-full">
      <div className="w-64 shrink-0 overflow-y-auto border-r border-border p-2">
        <div className="px-2 py-1 text-xs text-muted-foreground">审计会话（{list.length}）</div>
        {list.map((c) => (
          <button
            key={c.conversationId}
            type="button"
            onClick={() => setSelected(c.conversationId)}
            className={`mb-1 block w-full rounded-md px-3 py-2 text-left text-sm ${
              selected === c.conversationId ? "bg-accent" : "hover:bg-accent"
            }`}
          >
            <div className="truncate font-medium">{c.title || "(无标题)"}</div>
            <div className="text-xs text-muted-foreground">
              {c.turnCount} prompts · {formatTokens(c.totalTokens)} tok ·{" "}
              {formatDurationMs(c.totalDurationMs)}
            </div>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!detail ? (
          <div className="text-sm text-muted-foreground">选择左侧会话查看审计详情</div>
        ) : (
          <div className="space-y-4">
            {detail.turns.map((t) => {
              const tok = t.usage
                ? t.usage.inputTokens +
                  t.usage.outputTokens +
                  t.usage.cacheCreationInputTokens +
                  t.usage.cacheReadInputTokens
                : undefined;
              return (
                <div key={t.taskId} className="rounded-lg border border-border p-3">
                  <div className="mb-2 text-xs text-muted-foreground">
                    {t.status} · {formatDurationMs(t.durationMs)} · {formatTokens(tok)} tok ·{" "}
                    {t.createdAt}
                  </div>
                  <div className="space-y-1.5">
                    {t.events.map((e) => (
                      <EventRow key={e.id} e={e} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
    return <div className="whitespace-pre-wrap break-words text-sm">{e.text}</div>;
  }
  if (e.type === "tool_use") {
    return (
      <div className="text-xs">
        🔧 <span className="font-mono">{e.toolName}</span>{" "}
        <code className="text-muted-foreground">{e.toolInput}</code>
      </div>
    );
  }
  if (e.type === "tool_result") {
    return (
      <details className="text-xs text-muted-foreground">
        <summary>
          └ {e.isError ? "❌ " : ""}output · {formatDurationMs(e.durationMs)}
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{e.toolOutput}</pre>
      </details>
    );
  }
  if (e.type === "result") {
    return <div className="text-xs">{e.isError === undefined ? "✅" : "✅"} result</div>;
  }
  return null;
}
