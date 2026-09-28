import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { Segmented } from "../components/ui/segmented";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { fetchSystemEvents, type SystemEvent } from "../lib/adminUsers";
import { fetchAgentMeta } from "../lib/agents";
import {
  type AuditConversationListItem,
  type AuditDetail,
  type AuditEventDTO,
  debugLlmInput,
  fetchAuditConversations,
  fetchAuditDetail,
  fetchKbAuditRevisions,
  fetchKbSearchStats,
  formatDateTime,
  formatDurationMs,
  formatTokens,
  type KbRevisionAuditDTO,
} from "../lib/audit";
import { fetchMe } from "../lib/auth";
import { llmSdkLabel, llmSdkTone } from "../lib/llmSdk";
import { cn } from "../lib/utils";

/** 系统事件类型 → 展示标签（新事件类型在此登记） */
const SYSTEM_EVENT_LABEL: Record<string, string> = {
  user_role_change: "角色变更",
};

function systemEventLabel(type: string): string {
  return SYSTEM_EVENT_LABEL[type] ?? "系统";
}

/** 轮次状态 → 中文标签 + 语义色（未知状态回退 neutral） */
const TURN_STATUS: Record<
  string,
  { label: string; tone: "success" | "danger" | "info" | "warning" | "neutral" }
> = {
  done: { label: "已完成", tone: "success" },
  success: { label: "成功", tone: "success" },
  error: { label: "失败", tone: "danger" },
  failed: { label: "失败", tone: "danger" },
  running: { label: "运行中", tone: "info" },
  stopped: { label: "已停止", tone: "warning" },
};

function turnStatus(status: string) {
  return TURN_STATUS[status] ?? { label: status, tone: "neutral" as const };
}

/** 加载失败重试盒：列表/详情/调试三处共用，错误必须可见可重试 */
function ErrorRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg bg-destructive-soft p-3">
      <p className="text-xs font-medium text-destructive">加载失败：{message}</p>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" />
        重试
      </Button>
    </div>
  );
}

/** 列表/详情加载骨架 */
function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}

/**
 * 审计模块唯一页面：顶部 Segmented 切换「历史会话 / LLM 观测」双形态——
 * 历史会话（轮次/事件/token），LLM 观测（SDK 原始输入输出 + 调试重放）。
 * mode 经 URL query 持久化（/audit?mode=llm），刷新/分享不丢。
 * 响应式：<lg 单列纵排（调试重放为全屏抽屉），lg+ 双栏 + 内联调试栏。
 */
export function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const llmMode = searchParams.get("mode") === "llm";
  const setLlmMode = (mode: "history" | "llm") =>
    setSearchParams(mode === "llm" ? { mode: "llm" } : {});

  const [list, setList] = useState<AuditConversationListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [_listReload, setListReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [_detailReload, setDetailReload] = useState(0);

  // 会话栏折叠 + 系统事件栏（admin 专属，spec 2026-09-21-user-management-design 决策③）
  const [convCollapsed, setConvCollapsed] = useState(false);
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [eventsError, setEventsError] = useState("");
  const isAdmin = me?.role === "admin";

  // 知识库修订（spec §10.4）：member=本人相关库 / admin 全量；点开单条看 diff 详情
  const [kbRevisions, setKbRevisions] = useState<KbRevisionAuditDTO[]>([]);
  const [kbNames, setKbNames] = useState<Record<string, string>>({});
  const [kbError, setKbError] = useState("");

  const loadKbRevisions = useCallback(() => {
    setKbError("");
    fetchKbAuditRevisions()
      .then((r) => {
        setKbRevisions(r.revisions);
        setKbNames(r.kbNames);
      })
      .catch((reason: unknown) =>
        setKbError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  // kb_search 0 命中率（R-E，admin）：检索质量信号——持续偏高说明 grep/词面检索触及上限，
  // 是评估引入向量检索层的客观触发依据
  const [searchStats, setSearchStats] = useState<{ total: number; zeroHit: number } | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    fetchKbSearchStats()
      .then(setSearchStats)
      .catch(() => setSearchStats(null));
  }, [isAdmin]);

  const loadEvents = useCallback(() => {
    setEventsError("");
    fetchSystemEvents()
      .then(setEvents)
      .catch((reason: unknown) =>
        setEventsError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  useEffect(() => {
    void fetchMe().then((user) => {
      setMe(user ? { id: user.id, role: user.role } : null);
      if (user?.role === "admin") loadEvents();
    });
    loadKbRevisions();
  }, [loadEvents, loadKbRevisions]);

  // LLM 观测的调试重放（仅 LLM 模式使用）
  const [presets, setPresets] = useState<Array<{ id: string; name: string; model: string }>>([]);
  const [presetsError, setPresetsError] = useState("");
  const [presetId, setPresetId] = useState("");
  const [debugInput, setDebugInput] = useState<string | null>(null);
  const [debugEventId, setDebugEventId] = useState<string | null>(null);
  const [debugOutput, setDebugOutput] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugging, setDebugging] = useState(false);

  useEffect(() => {
    let stale = false;
    setListLoading(true);
    setListError("");
    fetchAuditConversations()
      .then((rows) => {
        if (!stale) setList(rows);
      })
      .catch((reason: unknown) => {
        if (!stale) setListError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!stale) setListLoading(false);
      });
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    if (!llmMode) return;
    setPresetsError("");
    fetchAgentMeta()
      .then((meta) => {
        setPresets(meta.llmPresets);
        setPresetId((current) => current || meta.llmPresets[0]?.id || "");
      })
      .catch((reason: unknown) => {
        setPresets([]);
        setPresetsError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [llmMode]);

  // 详情加载：序号守卫防快速切换会话时的旧响应回写
  const detailSeq = useRef(0);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError("");
    fetchAuditDetail(selected)
      .then((d) => {
        if (seq === detailSeq.current) setDetail(d);
      })
      .catch((reason: unknown) => {
        if (seq === detailSeq.current)
          setDetailError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (seq === detailSeq.current) setDetailLoading(false);
      });
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

  const closeDebug = () => setDebugInput(null);

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

  // 调试抽屉 Esc 关闭
  useEffect(() => {
    if (debugInput === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDebug();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [debugInput, closeDebug]);

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
        actions={
          <Segmented
            name="审计视图"
            options={[
              { value: "history", label: "历史会话" },
              { value: "llm", label: "LLM 观测" },
            ]}
            value={llmMode ? "llm" : "history"}
            onChange={setLlmMode}
          />
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pb-7 pt-5 lg:flex-row lg:overflow-hidden">
        {/* 左：会话列表（可折叠）+ 系统事件栏（admin 专属）+ 知识库修订 */}
        <div className="flex w-full shrink-0 flex-col gap-4 lg:w-80">
          <Card
            className={cn(
              "flex min-h-0 max-h-80 flex-col overflow-hidden lg:max-h-none",
              convCollapsed && "max-h-none shrink-0",
            )}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <button
                type="button"
                onClick={() => setConvCollapsed((v) => !v)}
                aria-expanded={!convCollapsed}
                className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
              >
                {convCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                会话（{list.length}）
              </button>
            </div>
            {!convCollapsed && (
              <div className="flex-1 overflow-y-auto p-2">
                {listLoading ? (
                  <div className="p-1">
                    <ListSkeleton />
                  </div>
                ) : listError ? (
                  <div className="p-1">
                    <ErrorRetry message={listError} onRetry={() => setListReload((v) => v + 1)} />
                  </div>
                ) : list.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    暂无会话记录
                  </p>
                ) : (
                  list.map((c) => (
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
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="truncate">
                          {c.turnCount} prompts · {formatTokens(c.totalTokens)} tok ·{" "}
                          {formatDurationMs(c.totalDurationMs)}
                        </span>
                        {c.llmSdkType ? (
                          <Badge
                            tone={llmSdkTone(c.llmSdkType)}
                            className="ml-auto shrink-0 px-1.5"
                          >
                            {llmSdkLabel(c.llmSdkType)}
                          </Badge>
                        ) : null}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </Card>

          {/* 系统事件（admin；角色变更等系统级重要事件，与左侧会话审计是两个口径） */}
          {isAdmin && (
            <Card
              className={cn(
                "flex flex-col overflow-hidden",
                convCollapsed ? "min-h-0 flex-1" : "h-60 shrink-0",
              )}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="text-xs font-semibold text-muted-foreground">
                  事件（{events.length}）
                </span>
                <Button variant="secondary" size="sm" onClick={loadEvents}>
                  <RefreshCw className="h-3 w-3" />
                  刷新
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {eventsError ? (
                  <p className="px-2 py-1 text-xs text-destructive">{eventsError}</p>
                ) : events.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">暂无系统事件</p>
                ) : (
                  events.map((ev) => (
                    <div key={ev.id} className="mb-0.5 rounded-lg px-3 py-2 hover:bg-muted">
                      <div className="flex items-center gap-1.5">
                        <Badge tone="primary">{systemEventLabel(ev.type)}</Badge>
                        <span className="text-[11px] text-muted-foreground">
                          {formatDateTime(ev.createdAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 break-words text-[12px] leading-5">{ev.detail}</div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          )}

          {/* 知识库修订（spec §10.4）：member=本人相关库 / admin 全量；展开看变更 diff */}
          <Card className="h-72 shrink-0 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-xs font-semibold text-muted-foreground">
                知识库（{kbRevisions.length}）
              </span>
              <Button variant="secondary" size="sm" onClick={loadKbRevisions}>
                <RefreshCw className="h-3 w-3" />
                刷新
              </Button>
            </div>
            {isAdmin && searchStats && searchStats.total > 0 ? (
              <div className="border-b border-border px-4 py-1.5 text-[11px] text-muted-foreground">
                kb_search 近 {searchStats.total} 次 · 0 命中 {searchStats.zeroHit} 次（
                {Math.round((searchStats.zeroHit / searchStats.total) * 100)}
                %）——持续偏高为引入向量检索层的触发信号
              </div>
            ) : null}
            <div className="flex-1 overflow-y-auto p-2">
              {kbError ? (
                <p className="px-2 py-1 text-xs text-destructive">{kbError}</p>
              ) : kbRevisions.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">暂无知识库变更</p>
              ) : (
                kbRevisions.map((rev) => (
                  <details key={rev.id} className="mb-0.5 rounded-lg px-3 py-2 hover:bg-muted">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-center gap-1.5">
                        <Badge tone="primary">{KB_ACTION_LABEL[rev.action] ?? rev.action}</Badge>
                        <span className="min-w-0 truncate text-[12px] font-medium">
                          {kbNames[rev.kbId] ?? "已删除库"}
                          {rev.path ? ` · ${rev.path}` : ""}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                          {formatDateTime(rev.createdAt)}
                        </span>
                      </div>
                      {rev.summary ? (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {rev.summary}
                        </div>
                      ) : null}
                    </summary>
                    <div className="mt-1 space-y-1">
                      <div className="text-[11px] text-muted-foreground">
                        变更方式：{KB_ACTOR_LABEL[rev.actorKind] ?? rev.actorKind}
                        {rev.conversationId ? ` · 来源会话 ${rev.conversationId.slice(0, 8)}` : ""}
                      </div>
                      {rev.diffText ? (
                        <pre className="overflow-x-auto rounded bg-muted p-2 text-[11px] leading-4">
                          {rev.diffText}
                        </pre>
                      ) : null}
                    </div>
                  </details>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* 右：详情（形态随页头 Segmented 切换；已选会话保持不变）。
            移动端转录内联会撑出数万 px 长页：内容自适应高度、限高 70vh 内部滚动
            （不能沿用 flex-1——列表卡占满后剩余空间为 0 会把盒子压没）；lg+ 恢复列内滚动 */}
        <div className="max-h-[70vh] min-w-0 shrink-0 space-y-4 overflow-y-auto lg:max-h-none lg:flex-1 lg:shrink lg:overflow-y-auto">
          {selected && detailError ? (
            <ErrorRetry message={detailError} onRetry={() => setDetailReload((v) => v + 1)} />
          ) : detailLoading ? (
            <Card className="space-y-3 p-4">
              <div className="h-5 w-40 animate-pulse rounded bg-muted" />
              <div className="h-24 animate-pulse rounded-lg bg-muted" />
              <div className="h-24 animate-pulse rounded-lg bg-muted" />
            </Card>
          ) : llmMode ? (
            <LlmDetail detail={detail} llmEventCount={llmEventCount} onDebug={startDebug} />
          ) : (
            <HistoryDetail detail={detail} />
          )}
        </div>

        {/* LLM 观测的调试重放：<lg 全屏抽屉（遮罩+Esc），lg+ 内联侧栏 */}
        {llmMode && debugInput !== null && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/40 lg:hidden"
              onClick={closeDebug}
              aria-hidden="true"
            />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label="调试 LLM Input"
              className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col overflow-y-auto border-l border-border bg-background p-4 shadow-xl lg:static lg:z-auto lg:w-[min(42rem,45vw)] lg:min-w-[20rem] lg:bg-transparent lg:p-0 lg:pl-4 lg:shadow-none"
            >
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold">调试 LLM Input</h2>
                <Button variant="secondary" size="sm" onClick={closeDebug} aria-label="关闭调试">
                  <X className="h-3.5 w-3.5" />
                  关闭
                </Button>
              </div>
              <div className="mb-2 flex items-center gap-2 text-sm">
                <label htmlFor="debug-model" className="shrink-0 text-[13px] font-medium">
                  模型
                </label>
                <Select
                  id="debug-model"
                  className="min-w-0 flex-1"
                  value={presetId}
                  onChange={(event) => setPresetId(event.target.value)}
                >
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}（{preset.model}）
                    </option>
                  ))}
                  {presets.length === 0 && <option value="">默认模型</option>}
                </Select>
              </div>
              {presetsError ? (
                <p className="mb-2 text-[11px] text-warning-foreground">
                  模型预设加载失败，可手动改写输入后用默认模型调试
                </p>
              ) : null}
              <Textarea
                mono
                aria-label="可编辑的 LLM input"
                value={debugInput}
                onChange={(event) => setDebugInput(event.target.value)}
                className="min-h-64 flex-1 resize-none"
              />
              <Button
                className="mt-3"
                disabled={debugging || !debugInput.trim()}
                onClick={() => void submitDebug()}
              >
                {debugging ? "调用中…" : "发送"}
              </Button>
              {debugEventId && (
                <div className="mt-2 text-[11px] text-muted-foreground">来源：{debugEventId}</div>
              )}
              {debugError && (
                <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-destructive-soft p-3 text-xs text-destructive">
                  {debugError}
                </pre>
              )}
              {debugOutput && (
                <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
                  {debugOutput}
                </pre>
              )}
            </aside>
          </>
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
      {detail.conversation ? (
        <div className="flex items-center gap-2">
          <h2 className="truncate text-lg font-bold">{detail.conversation.title || "历史会话"}</h2>
          {detail.conversation.llmSdkType ? (
            <Badge
              tone={llmSdkTone(detail.conversation.llmSdkType)}
              title="最近一次运行所用 Agent SDK"
              className="shrink-0"
            >
              {llmSdkLabel(detail.conversation.llmSdkType)}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {detail.turns.map((t) => {
        const tok = t.usage
          ? t.usage.inputTokens +
            t.usage.outputTokens +
            t.usage.cacheCreationInputTokens +
            t.usage.cacheReadInputTokens
          : undefined;
        const status = turnStatus(t.status);
        return (
          <Card key={t.taskId} className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[13px] font-semibold">Turn {t.taskId.slice(0, 8)}</div>
              <Badge tone={status.tone}>{status.label}</Badge>
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
        <div className="flex items-center gap-2">
          <h2 className="truncate text-lg font-bold">{detail.conversation?.title || "LLM 会话"}</h2>
          {detail.conversation?.llmSdkType ? (
            <Badge
              tone={llmSdkTone(detail.conversation.llmSdkType)}
              title="最近一次运行所用 Agent SDK"
              className="shrink-0"
            >
              {llmSdkLabel(detail.conversation.llmSdkType)}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{llmEventCount} 条 SDK 原始消息</p>
      </div>
      {detail.turns.map((turn) => {
        const status = turnStatus(turn.status);
        return (
          <Card key={turn.taskId} className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {formatDateTime(turn.createdAt)}
              <Badge tone={status.tone}>{status.label}</Badge>
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
          </Card>
        );
      })}
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
          <Button variant="secondary" size="sm" onClick={() => onDebug(event)}>
            调试
          </Button>
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
          {event.llmInput}
        </pre>
      </div>
    );
  }
  return (
    <details open className="rounded-lg border border-success/30 bg-success-soft p-3">
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
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary text-white">
          <Wrench className="h-3 w-3" aria-hidden="true" />
        </span>
        <span className="font-mono font-medium text-primary">{e.toolName}</span>
        <code className="truncate text-muted-foreground">{e.toolInput}</code>
      </div>
    );
  }
  if (e.type === "tool_result") {
    return (
      <details className="px-3 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer items-center gap-1 py-1">
          └{e.isError ? <XCircle className="h-3 w-3 text-destructive" aria-hidden="true" /> : null}
          output · {formatDurationMs(e.durationMs)}
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2">
          {e.toolOutput}
        </pre>
      </details>
    );
  }
  if (e.type === "result") {
    return (
      <div className="flex items-center gap-1 px-3 text-xs text-success">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        result
      </div>
    );
  }
  return null;
}

/** 知识库修订标签（spec §10.4） */
const KB_ACTION_LABEL: Record<string, string> = {
  create: "新建",
  update: "更新",
  delete: "删除",
  config: "配置",
  import: "导入",
  "library-deleted": "删库",
};
const KB_ACTOR_LABEL: Record<string, string> = {
  manual: "页面",
  chat: "对话",
  "auto-learn": "自动学习",
  memory: "记忆",
  import: "迁移",
  system: "系统",
};
