import { RefreshCw, Square } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useDirtyGuard } from "../components/ui/dirty-guard";
import { FormField, FormSection } from "../components/ui/form-section";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { apiFetch } from "../lib/auth";
import { eventNameLabel, runStatusLabel, runStatusTone } from "../lib/runStatus";

type EventType = "system" | "schedule" | "call";

interface EventOption {
  id: string;
  name: string;
  type: EventType;
}

interface WorkflowDTO {
  id: string;
  name: string;
  description?: string;
  eventId: string;
  agentId: string;
  promptTemplate?: string;
  enabled: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
}

interface RunStats {
  total: number;
  queued: number;
  running: number;
  success: number;
  failed: number;
  stopped: number;
  avgDurationMs: number | null;
}

interface RunDTO {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "stopped";
  /** 派生标记：running 且会话任务正卡在人工审批门（后端按任务状态计算，不入库） */
  awaitingApproval?: boolean;
  eventName: string;
  context?: string | null;
  renderedPrompt?: string | null;
  conversationId?: string | null;
  error?: string | null;
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** 各事件类型的提示词可用变量（与后端 buildPromptVars 契约一致） */
const VAR_BASE = ["triggerOutput", "firedAt", "eventName"];
function varsForEvent(type: EventType | undefined): string[] {
  const vars = [...VAR_BASE];
  if (type === "call") vars.push("query", "data");
  return vars;
}

function durationText(startedAt?: string | null, finishedAt?: string | null): string {
  if (!startedAt) return "—";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const ms = Math.max(0, end - Date.parse(startedAt));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function WorkflowEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [eventId, setEventId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("{{triggerOutput}}");
  const [enabled, setEnabled] = useState(false);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [refsTick, setRefsTick] = useState(0);
  const [loading, setLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 执行记录
  const [stats, setStats] = useState<RunStats | null>(null);
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const [canShowRecords, setCanShowRecords] = useState(Boolean(id));

  const snapshot = JSON.stringify({ name, description, eventId, agentId, promptTemplate });
  const pristineRef = useRef<string | null>(null);
  useEffect(() => {
    if (loaded && pristineRef.current === null) pristineRef.current = snapshot;
  }, [loaded, snapshot]);
  const dirty = pristineRef.current !== null && snapshot !== pristineRef.current;
  const { attempt, dialog } = useDirtyGuard(dirty && !saving);

  // 事件 / Agent 下拉选项；失败显式可重试
  // biome-ignore lint/correctness/useExhaustiveDependencies: refsTick 仅用于手动重试时触发重新加载
  useEffect(() => {
    let cancelled = false;
    setRefsError(null);
    void (async () => {
      try {
        const [ev, ag] = await Promise.all([
          apiFetch("/api/events").then((r) => r.json() as Promise<{ events?: EventOption[] }>),
          fetchAgents(),
        ]);
        if (cancelled) return;
        setEvents(ev.events ?? []);
        setAgents(ag);
      } catch (e) {
        if (!cancelled) setRefsError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refsTick]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await apiFetch(`/api/workflows/${id}`);
      if (!r.ok) throw new Error(`加载失败（HTTP ${r.status}）`);
      const w = (await r.json()) as WorkflowDTO;
      setName(w.name);
      setDescription(w.description ?? "");
      setEventId(w.eventId);
      setAgentId(w.agentId);
      if (w.promptTemplate) setPromptTemplate(w.promptTemplate);
      setEnabled(w.enabled);
      setLoaded(true);
      pristineRef.current = null; // 下一个 effect 以加载后的快照钉基线
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshRuns = useCallback(async () => {
    if (!id) return;
    try {
      const [sr, rr] = await Promise.all([
        apiFetch(`/api/workflows/${id}/runs/stats`),
        apiFetch(`/api/workflows/${id}/runs?limit=50`),
      ]);
      if (sr.ok) setStats((await sr.json()) as RunStats);
      if (rr.ok) {
        const d = (await rr.json()) as { runs?: RunDTO[] };
        setRuns(d.runs ?? []);
      }
    } catch {
      // 记录面刷新失败不打断编辑
    }
  }, [id]);

  useEffect(() => {
    if (!canShowRecords) return;
    void refreshRuns();
  }, [canShowRecords, refreshRuns]);

  // 存在 queued/running 行时 3s 轮询，静止即停
  useEffect(() => {
    if (!canShowRecords) return;
    const active = runs.some((r) => r.status === "queued" || r.status === "running");
    if (!active) return;
    const t = setInterval(() => void refreshRuns(), 3000);
    return () => clearInterval(t);
  }, [runs, canShowRecords, refreshRuns]);

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError("请填写名称");
      return;
    }
    if (!eventId) {
      setError("请选择订阅的事件");
      return;
    }
    if (!agentId) {
      setError("请选择 Agent");
      return;
    }
    setSaving(true);
    try {
      const url = id ? `/api/workflows/${id}` : "/api/workflows";
      const method = id ? "PUT" : "POST";
      const r = await apiFetch(url, {
        method,
        body: JSON.stringify({
          name,
          description: description || undefined,
          eventId,
          agentId,
          promptTemplate,
        }),
      });
      if (r.ok) {
        const saved = (await r.json()) as WorkflowDTO;
        if (!id) {
          nav(`/workflows/${saved.id}`);
          return;
        }
        setNotice("已保存");
        setCanShowRecords(true);
        void refreshRuns();
        return;
      }
      let msg = await r.text();
      try {
        msg = (JSON.parse(msg) as { error?: string }).error ?? msg;
      } catch {
        // 非 JSON 响应保持原文
      }
      setError(`保存失败：${msg}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (next: boolean) => {
    if (!id) {
      setNotice("先保存后再启用");
      return;
    }
    setEnabled(next);
    const r = await apiFetch(`/api/workflows/${id}/${next ? "enable" : "disable"}`, {
      method: "POST",
    });
    if (!r.ok) {
      setNotice(`操作失败：HTTP ${r.status}`);
      setEnabled(!next);
    }
  };

  const runNow = async () => {
    if (!id) {
      setNotice("先保存后再运行");
      return;
    }
    setRunningNow(true);
    try {
      const r = await apiFetch(`/api/workflows/${id}/run`, { method: "POST" });
      if (!r.ok) {
        const body = await r.text();
        setNotice(`运行失败：${r.status} ${body}`);
      } else {
        setNotice("已触发，执行记录稍后刷新");
        void refreshRuns();
      }
    } finally {
      setRunningNow(false);
    }
  };

  const stopRun = async (rid: string) => {
    if (!id) return;
    const r = await apiFetch(`/api/workflows/${id}/runs/${rid}/stop`, { method: "POST" });
    if (!r.ok) {
      setNotice(`停止失败：HTTP ${r.status}`);
      return;
    }
    void refreshRuns();
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
        <div className="h-10 w-52 animate-pulse rounded bg-muted" />
        <div className="mt-5 space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
        <PageHeader className="mb-4" title={id ? "编辑工作流" : "新建工作流"} />
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
          <span>工作流加载失败：{loadError}</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" size={14} />
            重试
          </Button>
        </div>
      </div>
    );
  }

  const selectedEvent = events.find((e) => e.id === eventId);
  const vars = varsForEvent(selectedEvent?.type);

  return (
    <div className="mx-auto max-w-2xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        className="mb-5"
        title={id ? "编辑工作流" : "新建工作流"}
        description="订阅事件命中后驱动智能体执行一次任务；每次执行都是一条独立会话"
        actions={
          <>
            {id && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                启用
                <Switch checked={enabled} onCheckedChange={(v) => void toggleEnabled(v)} />
              </div>
            )}
            <Button variant="secondary" onClick={() => attempt(() => nav("/workflows"))}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      />
      {error && (
        <div className="rounded-lg bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg bg-success-soft px-3 py-2.5 text-sm text-success">{notice}</div>
      )}

      <FormSection id="wf-sec-basic" no="1" title="基础信息">
        <FormField label="名称" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 每日 issue 汇总"
          />
        </FormField>
        <FormField label="描述">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="工作流用途说明（可选）"
          />
        </FormField>
      </FormSection>

      <FormSection
        id="wf-sec-run"
        no="2"
        title="执行配置"
        description="订阅事件、执行智能体与提示词模板"
      >
        {refsError ? (
          <button
            type="button"
            className="w-fit rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive-soft"
            onClick={() => setRefsTick((t) => t + 1)}
          >
            事件 / Agent 列表加载失败，点击重试
          </button>
        ) : (
          <>
            <FormField label="订阅事件" required>
              <Select value={eventId} onChange={(e) => setEventId(e.target.value)}>
                <option value="">— 选择 —</option>
                {(["schedule", "call", "system"] as const).map((group) => {
                  const items = events.filter((e) => e.type === group);
                  if (!items.length) return null;
                  const label =
                    group === "schedule" ? "定时事件" : group === "call" ? "调用事件" : "系统默认";
                  return (
                    <optgroup key={group} label={label}>
                      {items.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </Select>
            </FormField>
            <FormField label="Agent" required>
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">— 选择 —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {!a._mine ? "（共享）" : ""}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        )}
        <FormField
          label="Prompt 模板"
          hint={
            <>
              可引用事件携带的上下文变量（点击插入）：
              {vars.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-primary-soft hover:text-primary"
                  onClick={() => setPromptTemplate((t) => `${t}{{${v}}}`)}
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </>
          }
        >
          <Textarea
            mono
            rows={4}
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
          />
        </FormField>
      </FormSection>

      {canShowRecords && (
        <FormSection
          id="wf-sec-runs"
          no="3"
          title="执行记录"
          description="每次执行一条记录（永久保留）；点开可看输入与完整对话"
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runNow()}
              disabled={runningNow}
            >
              {runningNow ? "触发中…" : "立即运行一轮"}
            </Button>
          }
        >
          {stats && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="总轮次" value={String(stats.total)} tone="text-primary" />
              <StatCard label="成功" value={String(stats.success)} tone="text-success" />
              <StatCard label="失败" value={String(stats.failed)} tone="text-destructive" />
              <StatCard
                label="平均耗时"
                value={
                  stats.avgDurationMs == null ? "—" : `${(stats.avgDurationMs / 1000).toFixed(1)}s`
                }
                tone="text-muted-foreground"
              />
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">入队时间</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">耗时</th>
                  <th className="px-3 py-2 font-medium">来源</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className="cursor-pointer border-t border-border hover:bg-muted/40"
                      onClick={() => setExpandedRun((cur) => (cur === r.id ? null : r.id))}
                    >
                      <td className="px-3 py-2">{new Date(r.queuedAt).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        {r.status === "running" && r.awaitingApproval ? (
                          <Badge tone="warning">等待审批</Badge>
                        ) : (
                          <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {durationText(r.startedAt, r.finishedAt)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {eventNameLabel(r.eventName)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span
                          className="inline-flex items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.conversationId && (
                            <a
                              href={`/?conv=${r.conversationId}`}
                              className="text-xs text-primary hover:underline"
                            >
                              查看对话
                            </a>
                          )}
                          {(r.status === "running" || r.status === "queued") && (
                            <Button variant="ghost" size="sm" onClick={() => void stopRun(r.id)}>
                              <Square aria-hidden="true" size={12} />
                              停止
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {expandedRun === r.id && (
                      <tr className="border-t border-border bg-muted/30">
                        <td colSpan={5} className="p-3">
                          {r.status === "running" && r.awaitingApproval && (
                            <div className="mb-2 text-sm text-warning-foreground">
                              <strong>该轮正等待人工审批</strong>
                              {r.conversationId && (
                                <>
                                  {" — "}
                                  <a href={`/?conv=${r.conversationId}`} className="underline">
                                    去对话处理
                                  </a>
                                </>
                              )}
                            </div>
                          )}
                          {r.error && (
                            <div className="mb-2 text-sm text-destructive">
                              <strong>失败原因：</strong>
                              {r.error}
                            </div>
                          )}
                          <div className="mb-1 text-xs text-muted-foreground">
                            事件上下文（triggerOutput）：
                          </div>
                          <pre className="max-h-40 overflow-auto rounded-lg bg-card p-2.5 text-xs">
                            {r.context ?? ""}
                          </pre>
                          <div className="mb-1 mt-2 text-xs text-muted-foreground">
                            渲染后 Prompt：
                          </div>
                          <pre className="max-h-48 overflow-auto rounded-lg bg-card p-2.5 text-xs">
                            {r.renderedPrompt ?? ""}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {!runs.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                还没有执行记录（保存并启用后由事件触发，或点「立即运行一轮」）
              </div>
            ) : null}
          </div>
        </FormSection>
      )}
      {dialog}
    </div>
  );
}

function StatCard(props: { label: string; value: string; tone: string }) {
  return (
    <Card className="flex flex-col gap-1 p-3">
      <span className={`text-lg font-bold leading-6 ${props.tone}`}>{props.value}</span>
      <span className="text-xs text-muted-foreground">{props.label}</span>
    </Card>
  );
}
