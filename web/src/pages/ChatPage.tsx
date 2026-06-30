import { useState } from "react";
import { Button } from "../components/ui/button";
import { useWebChat } from "../lib/webChat";

export function ChatPage() {
  const { messages, pendingApproval, connection, send, resolveApproval } = useWebChat("/ws");
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (!t) return;
    send(t);
    setText("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span
          className={
            connection === "open"
              ? "text-green-600"
              : connection === "connecting"
                ? "text-yellow-600"
                : "text-red-600"
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

        {pendingApproval && (
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
        )}
      </div>

      <div className="flex gap-2 border-t border-border p-3">
        <input
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
          value={text}
          placeholder="输入消息…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button onClick={submit}>发送</Button>
      </div>
    </div>
  );
}
