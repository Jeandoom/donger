import { useEffect, useMemo, useState } from "react";
import { fetchAgentMeta } from "../lib/agents";
import {
  type AuditConversationListItem,
  type AuditDetail,
  type AuditEventDTO,
  debugLlmInput,
  fetchAuditConversations,
  fetchAuditDetail,
} from "../lib/audit";

export function LlmSessionsPage() {
  const [list, setList] = useState<AuditConversationListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [presets, setPresets] = useState<Array<{ id: string; name: string; model: string }>>([]);
  const [debugInput, setDebugInput] = useState<string | null>(null);
  const [debugEventId, setDebugEventId] = useState<string | null>(null);
  const [presetId, setPresetId] = useState("");
  const [debugOutput, setDebugOutput] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugging, setDebugging] = useState(false);

  useEffect(() => {
    void fetchAuditConversations()
      .then(setList)
      .catch(() => setList([]));
    void fetchAgentMeta()
      .then((meta) => {
        setPresets(meta.llmPresets);
        setPresetId(meta.llmPresets[0]?.id ?? "");
      })
      .catch(() => setPresets([]));
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

  const llmEventCount = useMemo(
    () => detail?.turns.reduce((sum, turn) => sum + selectLlmEvents(turn.events).length, 0) ?? 0,
    [detail],
  );

  const startDebug = (event: AuditEventDTO) => {
    setDebugInput(event.llmInput ?? "");
    setDebugEventId(event.id);
    setDebugOutput(null);
    setDebugError(null);
  };

  const submitDebug = async () => {
    if (debugInput === null || !debugInput.trim()) return;
    setDebugging(true);
    setDebugOutput(null);
    setDebugError(null);
    try {
      const result = await debugLlmInput(debugInput, presetId || undefined);
      setDebugOutput(`[${result.model}]\n${result.output}`);
    } catch (error) {
      setDebugError(error instanceof Error ? error.message : "调试调用失败");
    } finally {
      setDebugging(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 overflow-y-auto border-r border-border p-2">
        <div className="px-2 py-1 text-xs text-muted-foreground">LLM 会话（{list.length}）</div>
        {list.map((item) => (
          <button
            key={item.conversationId}
            type="button"
            onClick={() => setSelected(item.conversationId)}
            className={`mb-1 block w-full rounded-md px-3 py-2 text-left text-sm ${
              selected === item.conversationId ? "bg-accent" : "hover:bg-accent"
            }`}
          >
            <div className="truncate font-medium">{item.title || "(无标题)"}</div>
            <div className="text-xs text-muted-foreground">
              {item.turnCount} 轮 · {item.lastAt}
            </div>
          </button>
        ))}
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto p-4">
        {!detail ? (
          <div className="text-sm text-muted-foreground">选择左侧会话查看 LLM inputs / outputs</div>
        ) : (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-semibold">{detail.conversation?.title || "LLM 会话"}</h1>
              <p className="text-xs text-muted-foreground">{llmEventCount} 条 SDK 原始消息</p>
            </div>
            {detail.turns.map((turn) => (
              <section key={turn.taskId} className="space-y-3 rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">
                  {turn.createdAt} · {turn.status}
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">用户 Query</div>
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm">
                    {turn.prompt}
                  </pre>
                </div>
                {selectLlmEvents(turn.events).map((event) => (
                  <LlmEvent key={event.id} event={event} onDebug={startDebug} />
                ))}
              </section>
            ))}
          </div>
        )}
      </main>

      {debugInput !== null && (
        <aside className="flex w-[min(42rem,45vw)] min-w-[20rem] shrink-0 flex-col border-l border-border p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">调试 LLM Input</h2>
            <button
              type="button"
              className="text-sm text-muted-foreground"
              onClick={() => setDebugInput(null)}
            >
              关闭
            </button>
          </div>
          <div className="mb-2 flex items-center gap-2 text-sm">
            <label htmlFor="debug-model">模型</label>
            <select
              id="debug-model"
              value={presetId}
              onChange={(event) => setPresetId(event.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}（{preset.model}）
                </option>
              ))}
              {presets.length === 0 && <option value="">默认模型</option>}
            </select>
          </div>
          <textarea
            aria-label="可编辑的 LLM input"
            value={debugInput}
            onChange={(event) => setDebugInput(event.target.value)}
            className="min-h-64 flex-1 resize-none rounded border border-border bg-background p-3 font-mono text-xs"
          />
          <button
            type="button"
            disabled={debugging || !debugInput.trim()}
            onClick={() => void submitDebug()}
            className="mt-3 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {debugging ? "调用中…" : "发送"}
          </button>
          {debugEventId && (
            <div className="mt-2 text-[10px] text-muted-foreground">来源：{debugEventId}</div>
          )}
          {debugError && (
            <pre className="mt-3 whitespace-pre-wrap break-words rounded bg-destructive/10 p-3 text-xs text-destructive">
              {debugError}
            </pre>
          )}
          {debugOutput && (
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
              {debugOutput}
            </pre>
          )}
        </aside>
      )}
    </div>
  );
}

function selectLlmEvents(events: AuditEventDTO[]): AuditEventDTO[] {
  return events.filter((event) => event.type === "llm_input" || isCompleteLlmOutput(event));
}

function isCompleteLlmOutput(event: AuditEventDTO): boolean {
  if (event.type !== "llm_output" || !event.llmOutput) return false;
  try {
    const output = JSON.parse(event.llmOutput) as { type?: unknown };
    return output.type === "assistant";
  } catch {
    return false;
  }
}

function LlmEvent({
  event,
  onDebug,
}: {
  event: AuditEventDTO;
  onDebug: (event: AuditEventDTO) => void;
}) {
  if (event.type === "llm_input") {
    return (
      <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3">
        <div className="mb-2 flex items-center justify-between text-xs font-medium">
          <span>LLM Input</span>
          <button
            type="button"
            onClick={() => onDebug(event)}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            调试
          </button>
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
          {event.llmInput}
        </pre>
      </div>
    );
  }
  return (
    <details open className="rounded border border-green-500/30 bg-green-500/5 p-3">
      <summary className="cursor-pointer text-xs font-medium">
        LLM Output · {event.recordedAt}
      </summary>
      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">
        {event.llmOutput}
      </pre>
    </details>
  );
}
