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

type EventType = "system" | "schedule" | "call" | "message";

interface EventOption {
  id: string;
  name: string;
  type: EventType;
  system?: { name: string; subjects?: string[]; timing?: string };
}

/** 执行完成事件（spec 2026-10-19-execution-completion-events-design）：与后端
 * event-payloads.ts 的 EXECUTION_COMPLETION_EVENT_NAMES 语义一致 */
const COMPLETION_EVENT_SYSTEM_NAMES = ["agent.execution.completed", "workflow.execution.completed"];

/** 与后端 WORKFLOW_COMPLETION_BRIEFING_TEMPLATE 保持一致：下游收自然语言简报而非 JSON */
const COMPLETION_BRIEFING_TEMPLATE = `【上游完成通知】工作流「{{workflowName}}」中的智能体「{{agentName}}」已{{statusWord}}（耗时 {{durationText}}）。
结论：
{{outputSummary}}

交付文件：
{{filesManifest}}

请基于上游执行结论继续任务。`;

interface WorkflowDTO {
  id: string;
  name: string;
  description?: string;
  eventId: string;
  agentId: string;
  /** 无人值守轮权限模式（ask_before_change | risk_guard | full_access）；旧数据缺省 full_access */
  permissionMode?: string;
  dedup?: { enabled: boolean };
  promptTemplate?: string;
  enabled: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
  /** L2 自动发布配置（缺省关闭） */
  autoDev?: {
    enabled: boolean;
    policy?: { maxFiles?: number; maxChangedLines?: number; dailyAutoMergeQuota?: number };
  };
  /** 通知策略（2026-10-20 反馈闭环 M2）：run 终态后由平台派生通知轮投递结果 */
  notifyPolicy?: {
    enabled: boolean;
    /** 正文来源：writer=写手智能体撰写（缺省）；direct=直接投递主 run 执行结果 */
    mode?: "writer" | "direct";
    on?: Array<"success" | "failed" | "stopped">;
    writerAgentId?: string;
    promptTemplate?: string;
    title?: string;
    channels?: Array<"inapp" | "dingtalk" | "webhook" | "email" | "source">;
    recipients?: "correlation" | "owner" | string[];
  };
}

interface ReleaseRunDTO {
  id: string;
  repositoryPath: string;
  mrNumber: string;
  mrUrl: string;
  sourceBranch: string;
  headSha: string;
  status: "needs_human" | "merged" | "merge_failed" | "deployed" | "rolled_back";
  policyVerdict?: { allow?: boolean; reasons?: string[]; warnings?: string[] };
  detail?: string | null;
  createdAt: string;
  updatedAt: string;
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

interface DedupEntryDTO {
  dedupKey: string;
  runId: string;
  status: "claimed" | "released";
  note: string | null;
  createdAt: string;
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

/** 各事件类型的提示词可用变量（与后端 buildPromptVars 契约一致；
 * 完成事件追加简报变量，见 spec §6） */
const VAR_BASE = ["triggerOutput", "firedAt", "eventName"];
function varsForEvent(event?: EventOption): string[] {
  const vars = [...VAR_BASE];
  if (event?.type === "call") vars.push("query", "data");
  if (event?.system && COMPLETION_EVENT_SYSTEM_NAMES.includes(event.system.name)) {
    vars.push(
      "workflowName",
      "agentName",
      "statusWord",
      "durationText",
      "outputSummary",
      "filesManifest",
    );
  }
  return vars;
}

/** L2 发布记录状态展示口径（与后端 ReleaseRunStatus 对齐） */
function releaseStatusLabel(status: string): string {
  const map: Record<string, string> = {
    needs_human: "待人工",
    merged: "已合并待发布",
    merge_failed: "合并失败",
    deployed: "已发布",
    rolled_back: "已回滚",
  };
  return map[status] ?? status;
}
function releaseStatusTone(status: string): "info" | "success" | "danger" | "warning" | "neutral" {
  const map: Record<string, "info" | "success" | "danger" | "warning" | "neutral"> = {
    needs_human: "warning",
    merged: "info",
    merge_failed: "danger",
    deployed: "success",
    rolled_back: "warning",
  };
  return map[status] ?? "neutral";
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
  const [permissionMode, setPermissionMode] = useState("full_access");
  const [dedupEnabled, setDedupEnabled] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState("{{triggerOutput}}");
  const [enabled, setEnabled] = useState(false);
  // L2 自动发布（分区默认收起，头部开关打开即展开）
  const [autoDevEnabled, setAutoDevEnabled] = useState(false);
  const [autoDevOpen, setAutoDevOpen] = useState(false);
  const [maxFiles, setMaxFiles] = useState("15");
  const [maxChangedLines, setMaxChangedLines] = useState("400");
  const [dailyQuota, setDailyQuota] = useState("3");
  // 通知策略（M2；分区默认收起，头部开关打开即展开）
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [notifyMode, setNotifyMode] = useState<"writer" | "direct">("writer");
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(true);
  const [notifyOnFailed, setNotifyOnFailed] = useState(false);
  const [notifyOnStopped, setNotifyOnStopped] = useState(false);
  const [notifyWriterAgentId, setNotifyWriterAgentId] = useState("");
  const [notifyTitle, setNotifyTitle] = useState("");
  const [notifyPrompt, setNotifyPrompt] = useState("");
  const [notifyRecipients, setNotifyRecipients] = useState<"correlation" | "owner">("correlation");
  const [notifyInapp, setNotifyInapp] = useState(true);
  const [notifyDingtalk, setNotifyDingtalk] = useState(false);
  const [notifyWebhook, setNotifyWebhook] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [notifySource, setNotifySource] = useState(false);
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
  const [dedupKeys, setDedupKeys] = useState<DedupEntryDTO[]>([]);
  const [releaseRuns, setReleaseRuns] = useState<ReleaseRunDTO[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const [canShowRecords, setCanShowRecords] = useState(Boolean(id));

  const snapshot = JSON.stringify({
    name,
    description,
    eventId,
    agentId,
    permissionMode,
    dedupEnabled,
    promptTemplate,
    autoDevEnabled,
    maxFiles,
    maxChangedLines,
    dailyQuota,
    notifyEnabled,
    notifyMode,
    notifyOnSuccess,
    notifyOnFailed,
    notifyOnStopped,
    notifyWriterAgentId,
    notifyTitle,
    notifyPrompt,
    notifyRecipients,
    notifyInapp,
    notifyDingtalk,
    notifyWebhook,
    notifyEmail,
    notifySource,
  });
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
      setPermissionMode(w.permissionMode ?? "full_access");
      setDedupEnabled(w.dedup?.enabled ?? false);
      if (w.promptTemplate) setPromptTemplate(w.promptTemplate);
      setEnabled(w.enabled);
      setAutoDevEnabled(w.autoDev?.enabled ?? false);
      setMaxFiles(String(w.autoDev?.policy?.maxFiles ?? 15));
      setMaxChangedLines(String(w.autoDev?.policy?.maxChangedLines ?? 400));
      setDailyQuota(String(w.autoDev?.policy?.dailyAutoMergeQuota ?? 3));
      const np = w.notifyPolicy;
      setNotifyEnabled(np?.enabled ?? false);
      setNotifyMode(np?.mode === "direct" ? "direct" : "writer");
      // 已配置开启的分区展开（默认收起针对新建/未启用形态）
      setAutoDevOpen(w.autoDev?.enabled ?? false);
      setNotifyOpen(np?.enabled ?? false);
      setNotifyOnSuccess(!np?.on?.length || np.on.includes("success"));
      setNotifyOnFailed(np?.on?.includes("failed") ?? false);
      setNotifyOnStopped(np?.on?.includes("stopped") ?? false);
      setNotifyWriterAgentId(np?.writerAgentId ?? "");
      setNotifyTitle(np?.title ?? "");
      setNotifyPrompt(np?.promptTemplate ?? "");
      setNotifyRecipients(
        np?.recipients === "owner" || Array.isArray(np?.recipients) ? "owner" : "correlation",
      );
      setNotifyInapp(!np?.channels?.length || np.channels.includes("inapp"));
      setNotifyDingtalk(np?.channels?.includes("dingtalk") ?? false);
      setNotifyWebhook(np?.channels?.includes("webhook") ?? false);
      setNotifyEmail(np?.channels?.includes("email") ?? false);
      setNotifySource(np?.channels?.includes("source") ?? false);
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
      const [sr, rr, dr, dk] = await Promise.all([
        apiFetch(`/api/workflows/${id}/runs/stats`),
        apiFetch(`/api/workflows/${id}/runs?limit=50`),
        apiFetch(`/api/workflows/${id}/release-runs`),
        apiFetch(`/api/workflows/${id}/dedup-keys`),
      ]);
      if (sr.ok) setStats((await sr.json()) as RunStats);
      if (rr.ok) {
        const d = (await rr.json()) as { runs?: RunDTO[] };
        setRuns(d.runs ?? []);
      }
      if (dr.ok) {
        const d = (await dr.json()) as { releaseRuns?: ReleaseRunDTO[] };
        setReleaseRuns(d.releaseRuns ?? []);
      }
      if (dk.ok) {
        const d = (await dk.json()) as { entries?: DedupEntryDTO[] };
        setDedupKeys(d.entries ?? []);
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
    if (notifyEnabled && !notifyOnSuccess && !notifyOnFailed && !notifyOnStopped) {
      setError("通知策略至少勾选一种触发时机");
      return;
    }
    if (notifyEnabled && !notifyInapp && !notifyDingtalk && !notifyWebhook && !notifyEmail) {
      setError("通知策略至少选择一个投递通道");
      return;
    }
    setSaving(true);
    try {
      const url = id ? `/api/workflows/${id}` : "/api/workflows";
      const method = id ? "PUT" : "POST";
      const notifyOn = [
        ...(notifyOnSuccess ? ["success"] : []),
        ...(notifyOnFailed ? ["failed"] : []),
        ...(notifyOnStopped ? ["stopped"] : []),
      ];
      const r = await apiFetch(url, {
        method,
        body: JSON.stringify({
          name,
          description: description || undefined,
          eventId,
          agentId,
          permissionMode,
          dedup: { enabled: dedupEnabled },
          promptTemplate,
          autoDev: {
            enabled: autoDevEnabled,
            policy: {
              maxFiles: Number(maxFiles) || 15,
              maxChangedLines: Number(maxChangedLines) || 400,
              dailyAutoMergeQuota: Number(dailyQuota) || 3,
            },
          },
          notifyPolicy: {
            enabled: notifyEnabled,
            on: notifyOn.length ? notifyOn : ["success"],
            mode: notifyMode,
            // direct 模式不投递写手配置（执行器不消费，落库保持语义干净）
            ...(notifyMode === "writer" && notifyWriterAgentId
              ? { writerAgentId: notifyWriterAgentId }
              : {}),
            ...(notifyTitle.trim() ? { title: notifyTitle.trim() } : {}),
            ...(notifyMode === "writer" && notifyPrompt.trim()
              ? { promptTemplate: notifyPrompt }
              : {}),
            channels: [
              ...(notifyInapp ? ["inapp"] : []),
              ...(notifyDingtalk ? ["dingtalk"] : []),
              ...(notifyWebhook ? ["webhook"] : []),
              ...(notifyEmail ? ["email"] : []),
              ...(notifySource ? ["source"] : []),
            ],
            recipients: notifyRecipients,
          },
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
  const isCompletionSubscription =
    selectedEvent?.system != null &&
    COMPLETION_EVENT_SYSTEM_NAMES.includes(selectedEvent.system.name);
  const vars = varsForEvent(selectedEvent);

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
        description="订阅事件、执行智能体、权限模式与提示词模板"
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
            <FormField
              label="订阅事件"
              required
              hint="执行完成事件：上游工作流/智能体跑完即触发本工作流（级联编排）"
            >
              <Select
                value={eventId}
                onChange={(e) => {
                  setEventId(e.target.value);
                  // 选中的是完成事件且模板仍是原始缺省 → 预填简报模板（spec §6）
                  const next = events.find((ev) => ev.id === e.target.value);
                  const nextIsCompletion =
                    next?.system != null &&
                    COMPLETION_EVENT_SYSTEM_NAMES.includes(next.system.name);
                  if (
                    nextIsCompletion &&
                    (promptTemplate === "{{triggerOutput}}" || !promptTemplate.trim())
                  ) {
                    setPromptTemplate(COMPLETION_BRIEFING_TEMPLATE);
                  }
                }}
              >
                <option value="">— 选择 —</option>
                {(["schedule", "call", "system", "message"] as const).map((group) => {
                  const items = events.filter((e) => e.type === group);
                  if (!items.length) return null;
                  const label =
                    group === "schedule"
                      ? "定时事件"
                      : group === "call"
                        ? "调用事件"
                        : group === "message"
                          ? "平台消息"
                          : "系统默认";
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
          label="权限模式"
          hint="仅对工作流触发的无人值守轮生效；无人值守时无人在场审批，默认完全权限。deny 级守卫（读写边界、工具白名单等）不受模式影响"
        >
          <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
            <option value="full_access">完全权限——零审批拦截（默认）</option>
            <option value="risk_guard">风险拦截——仅风险不变量弹卡</option>
            <option value="ask_before_change">变更前问询——命中审批门即弹卡</option>
          </Select>
        </FormField>
        <FormField
          label="处理登记（幂等）"
          hint="开启后轮内挂载 workflow-dedup 工具（claim/query/release）：对业务键（如 TB 任务 id）原子认领，同键多条件/多轮命中只有首次处理。配合提示词先 claim 再处理"
        >
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={dedupEnabled}
              onChange={(e) => setDedupEnabled(e.target.checked)}
              className="accent-primary"
            />
            启用处理登记（同键只处理一次）
          </label>
        </FormField>
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
              {isCompletionSubscription && (
                <button
                  type="button"
                  className="mx-1 rounded bg-primary-soft px-1.5 py-0.5 text-xs text-primary hover:underline"
                  onClick={() => setPromptTemplate(COMPLETION_BRIEFING_TEMPLATE)}
                >
                  填入完成简报模板
                </button>
              )}
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

      <FormSection
        id="wf-sec-autodev"
        no="3"
        title="自动发布（L2）"
        description="启用后平台轮询该 Agent 首个绑定仓库的 [autofix] MR：策略命中即自动合并，宿主管线构建发布、失败自动回滚；未命中转人工。合并与部署不经 LLM"
        collapsible
        collapsed={!autoDevOpen}
        onCollapsedChange={(c) => setAutoDevOpen(!c)}
        actions={
          <>
            <span className="text-xs text-muted-foreground">
              {autoDevEnabled ? "已开启" : "已关闭"}
            </span>
            <Switch
              checked={autoDevEnabled}
              onCheckedChange={(v) => {
                setAutoDevEnabled(v);
                if (v) setAutoDevOpen(true);
              }}
            />
          </>
        }
      >
        <div className="grid grid-cols-3 gap-3">
          <FormField label="文件数上限" hint="超过转人工">
            <Input
              type="number"
              min={1}
              value={maxFiles}
              onChange={(e) => setMaxFiles(e.target.value)}
            />
          </FormField>
          <FormField label="变更行数上限" hint="超过转人工">
            <Input
              type="number"
              min={1}
              value={maxChangedLines}
              onChange={(e) => setMaxChangedLines(e.target.value)}
            />
          </FormField>
          <FormField label="每日合并上限" hint="0=不限制">
            <Input
              type="number"
              min={0}
              value={dailyQuota}
              onChange={(e) => setDailyQuota(e.target.value)}
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          红线路径（安全门/部署/迁移/依赖清单/L2
          自身机制）与「修改既有测试」恒转人工，不受上述数值影响。
        </p>
      </FormSection>

      <FormSection
        id="wf-sec-notify"
        no="4"
        title="结果通知"
        description="执行结束后由平台投递结果通知（不发完成事件、不参与级联）：正文可直接使用执行结果，或由写手智能体改写；关闭则静默"
        collapsible
        collapsed={!notifyOpen}
        onCollapsedChange={(c) => setNotifyOpen(!c)}
        actions={
          <>
            <span className="text-xs text-muted-foreground">
              {notifyEnabled ? "已开启" : "已关闭"}
            </span>
            <Switch
              checked={notifyEnabled}
              onCheckedChange={(v) => {
                setNotifyEnabled(v);
                if (v) setNotifyOpen(true);
              }}
            />
          </>
        }
      >
        {!notifyEnabled ? (
          <p className="text-xs text-muted-foreground">开启开关后配置触发时机、收件人、通道与正文来源</p>
        ) : (
          <>
            <FormField label="触发时机" required hint="至少选一种">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                {(
                  [
                    ["success", "执行成功", notifyOnSuccess, setNotifyOnSuccess],
                    ["failed", "执行失败", notifyOnFailed, setNotifyOnFailed],
                    ["stopped", "被终止", notifyOnStopped, setNotifyOnStopped],
                  ] as const
                ).map(([key, label, checked, set]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => set(e.target.checked)}
                      className="accent-primary"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </FormField>
            <FormField
              label="收件人"
              hint="事件因果提交人=由触发事件载荷解析（如反馈提交人）；无因果键的触发（定时/手动）选此项将无法投递"
            >
              <Select
                value={notifyRecipients}
                onChange={(e) => setNotifyRecipients(e.target.value as "correlation" | "owner")}
              >
                <option value="correlation">事件因果提交人（如反馈提交人）</option>
                <option value="owner">工作流属主（我自己）</option>
              </Select>
            </FormField>
            <FormField
              label="通知通道"
              hint="站外通道还需收件人本人订阅启用（钉钉需绑定地址；邮件需管理员配置 SMTP）"
            >
              <div className="flex flex-wrap items-center gap-4 text-sm">
                {(
                  [
                    ["inapp", "站内信", notifyInapp, setNotifyInapp],
                    ["dingtalk", "钉钉", notifyDingtalk, setNotifyDingtalk],
                    ["webhook", "Webhook", notifyWebhook, setNotifyWebhook],
                    ["email", "邮件", notifyEmail, setNotifyEmail],
                    ["source", "回复来源（消息事件回群/回任务）", notifySource, setNotifySource],
                  ] as const
                ).map(([key, label, checked, set]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => set(e.target.checked)}
                      className="accent-primary"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </FormField>
            <FormField
              label="通知内容"
              hint={
                notifyMode === "direct"
                  ? "直接把本轮 Agent 的最终回复作为通知正文投递，不派生写手轮（零额外 token）"
                  : "由写手智能体基于执行简报改写成通知正文"
              }
            >
              <Select
                value={notifyMode}
                onChange={(e) => setNotifyMode(e.target.value as "writer" | "direct")}
              >
                <option value="writer">写手智能体撰写</option>
                <option value="direct">直接回复执行结果</option>
              </Select>
            </FormField>
            {notifyMode === "writer" && (
              <>
                <FormField
                  label="通知写手"
                  hint="把执行结论改写成通知正文的智能体；缺省=本工作流绑定的 Agent"
                >
                  <Select
                    value={notifyWriterAgentId}
                    onChange={(e) => setNotifyWriterAgentId(e.target.value)}
                  >
                    <option value="">— 跟随工作流 Agent —</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {!a._mine ? "（共享）" : ""}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label="写手指令模板"
                  hint={
                    <>
                      可用变量（点击插入）：
                      {["workflowName", "statusWord", "outputSummary"].map((v) => (
                        <button
                          key={v}
                          type="button"
                          className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-primary-soft hover:text-primary"
                          onClick={() => setNotifyPrompt((t) => `${t}{{${v}}}`)}
                        >
                          {`{{${v}}}`}
                        </button>
                      ))}
                      ；留空=平台默认通知员模板
                    </>
                  }
                >
                  <Textarea
                    mono
                    rows={3}
                    value={notifyPrompt}
                    onChange={(e) => setNotifyPrompt(e.target.value)}
                    placeholder="如：面向提交人写一段话，语气轻松，说明问题是否修复、如何验证"
                  />
                </FormField>
              </>
            )}
            <FormField label="通知标题" hint="留空=「工作流「名称」结果通知」">
              <Input
                value={notifyTitle}
                onChange={(e) => setNotifyTitle(e.target.value)}
                placeholder="如：你的反馈已处理完毕"
                maxLength={120}
              />
            </FormField>
          </>
        )}
      </FormSection>

      {canShowRecords && (
        <FormSection
          id="wf-sec-runs"
          no="5"
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
      {canShowRecords && autoDevEnabled && (
        <FormSection
          id="wf-sec-release-runs"
          no="6"
          title="自动发布记录"
          description="策略评估与合并/发布状态（宿主管线回报后更新）"
        >
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">MR</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">策略判定</th>
                </tr>
              </thead>
              <tbody>
                {releaseRuns.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      {r.mrUrl ? (
                        <a
                          href={r.mrUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          !{r.mrNumber}
                        </a>
                      ) : (
                        `!${r.mrNumber}`
                      )}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {r.headSha.slice(0, 8)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={releaseStatusTone(r.status)}>
                        {releaseStatusLabel(r.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.status === "needs_human" && r.policyVerdict?.reasons?.length
                        ? r.policyVerdict.reasons.join("；").slice(0, 120)
                        : releaseStatusLabel(r.status)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!releaseRuns.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                还没有自动发布记录（agent 提交 [autofix] MR 后由平台评估）
              </div>
            ) : null}
          </div>
        </FormSection>
      )}
      {canShowRecords && dedupEnabled ? (
        <FormSection
          id="wf-sec-dedup"
          no="7"
          title="处理登记（幂等键）"
          description="已认领的业务键（同键只处理一次）；处理失败可释放后重试"
        >
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">业务键</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">认领时间</th>
                  <th className="px-3 py-2 font-medium">备注</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {dedupKeys.map((d) => (
                  <tr key={d.dedupKey} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{d.dedupKey}</td>
                    <td className="px-3 py-2">
                      <Badge tone={d.status === "claimed" ? "info" : "neutral"}>
                        {d.status === "claimed" ? "已认领" : "已释放"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{d.note ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      {d.status === "claimed" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const url =
                              "/api/workflows/" + id + "/dedup-keys/" + encodeURIComponent(d.dedupKey) + "/release";
                            void apiFetch(url, { method: "POST" }).then(() => void refreshRuns());
                          }}
                        >
                          释放
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!dedupKeys.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                暂无登记（agent 调用 dedup_claim 后出现）
              </div>
            ) : null}
          </div>
        </FormSection>
      ) : null}
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
