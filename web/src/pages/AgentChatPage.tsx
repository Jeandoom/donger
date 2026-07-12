import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { type AgentDTO, fetchAgent, getOrCreateAgentConversation } from "../lib/agents";
import { useWebChat } from "../lib/webChat";

export function AgentChatPage() {
  const { id } = useParams();
  const [agent, setAgent] = useState<AgentDTO>();
  const [ready, setReady] = useState(false);
  const [text, setText] = useState("");
  const {
    messages,
    pendingApproval,
    connection,
    activeConversationId,
    send,
    resolveApproval,
    switchConversation,
  } = useWebChat();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const a = await fetchAgent(id);
        if (cancelled) return;
        setAgent(a);
        const c = await getOrCreateAgentConversation(id);
        if (cancelled) return;
        switchConversation(c.id); // 触发历史加载 + SSE 重连到该会话
        setReady(true);
      } catch {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, switchConversation]);

  function submit() {
    const t = text.trim();
    if (!t) return;
    send(t);
    setText("");
  }

  if (!agent || !ready) {
    return <div className="p-6 text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="text-sm">
          <span className="font-medium">{agent.name}</span>
          <span className="ml-2 text-muted-foreground">{agent.description ?? ""}</span>
        </div>
        <span
          className={
            connection === "open"
              ? "text-xs text-green-600"
              : connection === "connecting"
                ? "text-xs text-yellow-600"
                : "text-xs text-red-600"
          }
        >
          ● {connection === "open" ? "已连接" : connection === "connecting" ? "连接中" : "未连接"}
        </span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              m.role === "user"
                ? "ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-primary-foreground"
                : "mr-auto max-w-[80%] rounded-lg bg-muted px-3 py-2"
            }
          >
            <span className="whitespace-pre-wrap break-words text-sm">{m.text}</span>
          </div>
        ))}
        {pendingApproval ? (
          <div className="mr-auto max-w-[80%] rounded-lg border border-yellow-400 bg-yellow-50 p-3">
            <div className="text-sm font-semibold text-yellow-800">🔔 {pendingApproval.title}</div>
            <div className="mt-1 text-xs text-yellow-700">{pendingApproval.summary}</div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => resolveApproval(true)}>
                通过
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolveApproval(false, "Web 驳回")}
              >
                驳回
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex gap-2 border-t border-border p-3">
        <input
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
          value={text}
          placeholder={`向 ${agent.name} 发消息…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button onClick={submit} disabled={!activeConversationId}>
          发送
        </Button>
      </div>
    </div>
  );
}
