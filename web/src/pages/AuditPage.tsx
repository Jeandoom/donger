import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { Switch } from "../components/ui/switch";
import { fetchAgentMeta } from "../lib/agents";
import {
  type AuditConversationListItem,
  type AuditDetail,
  type AuditEventDTO,
  debugLlmInput,
  fetchAuditConversations,
  fetchAuditDetail,
  formatDateTime,
  formatDurationMs,
  formatTokens,
} from "../lib/audit";
import { cn } from "../lib/utils";

/**
 * 审计模块唯一页面：会话栏共用，「只看LLM」开关切换右侧详情形态——
 * 关=历史会话（轮次/事件/token），开=LLM 观测（SDK 原始输入输出 + 调试重放）。
 * mode 经 URL query 持久化（/audit?mode=llm），刷新/分享不丢。
 */
export function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const llmMode = searchParams.get("mode") === "llm";
  const setLlmMode = (on: boolean) => setSearchParams(on ? { mode: "llm" } : {});

  const [list, setList] = useState<AuditConversationListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);

  // LLM 观测的调试重放（仅 LLM 模式使用）
  const [presets, setPresets] = useState<Array<{ id: string; name: string; model: string }>>([]);
  const [presetId, setPresetId] = useState("");
  const [debugInput, setDebugInput] = useState<string | null>(null);
  const [debugEventId, setDebugEventId] = useState<string | null>(null);
  const [debugOutput, setDebugOutput] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugging, setDebugging] = useState(false);

  useEffect(() => {
    void fetchAuditConversations()
      .then(setList)
      .catch(() => setList([]));
  }, []);

  useEffect(() => {
    if (!llmMode) return;
    void fetchAgentMeta()
      .then((meta) => {
        setPresets(meta.llmPresets);
        setPresetId((current) => current || meta.llmPresets[0]?.id || "");
      })
      .catch(() => setPresets([]));
  }, [llmMode]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        className="px-7 pt-7"
        title={llmMode ? "LLM 观测" : "历史会话审计"}
        description={
          llmMode
            ? "查看每轮对话的 LLM 原始输入输出，支持改写重放调试"
            : "回看每个任务的轮次、事件与 token 消耗"
        }
      />
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-7 pb-7 pt-5">
        {/* 左：会话列表（两种模式共用） */}
        <Card className="flex w-80 shrink-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs font-semibold text-muted-foreground">
              会话（{list.length}）
            </span>
            <label
              htmlFor="audit-llm-switch"
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              只看LLM
              <Switch id="audit-llm-switch" checked={llmMode} onCheckedChange={setLlmMode} />
            </label>
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

        {/* 右：详情（形态随开关切换；已选会话保持不变） */}
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto">
          {llmMode ? (
            <LlmDetail detail={detail} llmEventCount={llmEventCount} onDebug={startDebug} />
          ) : (
            <HistoryDetail detail={detail} />
          )}
        </div>

        {/* LLM 观测的调试重放侧栏 */}
        {llmMode && debugInput !== null && (
          <aside className="flex w-[min(42rem,45vw)] min-w-[20rem] shrink-0 flex-col overflow-y-auto border-l border-border pl-4">
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
                className="min-w-0 flex-1 rounded-lg border border-border bg-card px-2 py-1 text-sm focus:border-primary focus:outline-none"
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
              className="min-h-64 flex-1 resize-none rounded-lg border border-border bg-card p-3 font-mono text-xs focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              disabled={debugging || !debugInput.trim()}
              onClick={() => void submitDebug()}
              className="mt-3 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
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
    </div>
  );
}

/** 历史会话详情：按轮展示事件流水 */
function HistoryDetail({ detail }: { detail: AuditDetail | null }) {
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
        选择左侧会话查看审计详情
      </div>
    );
  }
  return (
    <>
      {detail.turns.map((t) => {
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
                tone={t.status === "done" ? "success" : t.status === "error" ? "danger" : "info"}
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
      })}
    </>
  );
}

/** LLM 观测详情：按轮展示 SDK 原始输入输出 */
function LlmDetail({
  detail,
  llmEventCount,
  onDebug,
}: {
  detail: AuditDetail | null;
  llmEventCount: number;
  onDebug: (event: AuditEventDTO) => void;
}) {
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
        选择左侧会话查看 LLM inputs / outputs
      </div>
    );
  }
  return (
    <>
      <div>
        <h1 className="text-lg font-bold">{detail.conversation?.title || "LLM 会话"}</h1>
        <p className="text-xs text-muted-foreground">{llmEventCount} 条 SDK 原始消息</p>
      </div>
      {detail.turns.map((turn) => (
        <section
          key={turn.taskId}
          className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-[0_2px_8px_rgba(15,23,42,0.06)]"
        >
          <div className="text-xs text-muted-foreground">
            {formatDateTime(turn.createdAt)} · {turn.status}
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">用户 Query</div>
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm">
              {turn.prompt}
            </pre>
          </div>
          {selectLlmEvents(turn.events).map((event) => (
            <LlmEvent key={event.id} event={event} onDebug={onDebug} />
          ))}
        </section>
      ))}
    </>
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
      <div className="rounded-lg border border-primary/30 bg-primary-soft/60 p-3">
        <div className="mb-2 flex items-center justify-between text-xs font-medium">
          <span>LLM Input</span>
          <button
            type="button"
            onClick={() => onDebug(event)}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs hover:bg-muted"
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
    <details open className="rounded border border-success/30 bg-success-soft p-3">
      <summary className="cursor-pointer text-xs font-medium">
        LLM Output · {event.recordedAt}
      </summary>
      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">
        {event.llmOutput}
      </pre>
    </details>
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
