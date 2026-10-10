import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { apiFetch } from "../lib/auth";
import {
  eventNameLabel,
  relativeTime,
  runDurationText,
  runStatusLabel,
  runStatusTone,
} from "../lib/runStatus";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DialogShell } from "./ui/dialog-shell";

/** 卡片折叠区展示的记录条数上限（接口侧 limit 同步取 5） */
const MAX_ROWS = 5;

interface RunDTO {
  id: string;
  workflowId?: string;
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

/** 状态徽标口径：running 且卡审批门时显式标「等待审批」，与编辑器执行记录一致 */
function RunStatusBadge(props: { run: RunDTO }) {
  const { run: r } = props;
  if (r.status === "running" && r.awaitingApproval) {
    return <Badge tone="warning">等待审批</Badge>;
  }
  return <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>;
}

interface FiringDTO {
  id: string;
  source: string;
  context: string;
  matchedWorkflowCount: number;
  firedAt: string;
}

/**
 * 卡片底部「最近记录」折叠区（工作流卡片/事件卡片共用）：
 * 左侧折叠按钮，默认收起只看最新一条，展开看最近 5 条，每条行尾挂详情动作。
 */
function RecordSection(props: { label: string; emptyText: string; rows: ReactNode[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!props.rows.length) {
    return (
      <div className="border-t border-border pt-2.5 text-xs text-muted-foreground">
        {props.emptyText}
      </div>
    );
  }
  const visible = expanded ? props.rows.slice(0, MAX_ROWS) : props.rows.slice(0, 1);
  return (
    <div className="border-t border-border pt-2.5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? `收起${props.label}` : `展开${props.label}`}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" size={13} />
        ) : (
          <ChevronRight aria-hidden="true" size={13} />
        )}
        {props.label}
      </button>
      <div className="mt-1.5 flex flex-col items-stretch gap-1">{visible}</div>
    </div>
  );
}

function RecordRow(props: { left: ReactNode; onDetail: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">{props.left}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={props.onDetail}
      >
        详情
      </Button>
    </div>
  );
}

function ContextBlock(props: { label: string; text?: string | null }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{props.label}</div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2.5 text-xs">
        {props.text || "（空）"}
      </pre>
    </div>
  );
}

/** 工作流卡片底部：最近执行记录（status 维度，详情含上下文与渲染后 Prompt） */
export function WorkflowRunRecords(props: { workflowId: string }) {
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [detail, setDetail] = useState<RunDTO | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/workflows/${props.workflowId}/runs?limit=${MAX_ROWS}`)
      .then((r) => r.json() as Promise<{ runs?: RunDTO[] }>)
      .then((d) => {
        if (!cancelled) setRuns(d.runs ?? []);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.workflowId]);

  const rows = runs.slice(0, MAX_ROWS).map((r) => (
    <RecordRow
      key={r.id}
      onDetail={() => setDetail(r)}
      left={
        <>
          <RunStatusBadge run={r} />
          <span className="truncate">
            {eventNameLabel(r.eventName)} · {relativeTime(r.queuedAt)}
          </span>
        </>
      }
    />
  ));

  return (
    <>
      <RecordSection label="最近执行" emptyText="从未执行" rows={rows} />
      {detail && <RunDetailDialog run={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function RunDetailDialog(props: { run: RunDTO; onClose: () => void }) {
  const r = props.run;
  return (
    <DialogShell
      title="执行详情"
      subtitle={
        <span className="flex items-center gap-1.5">
          <RunStatusBadge run={r} />
          {eventNameLabel(r.eventName)} · {new Date(r.queuedAt).toLocaleString()} · 耗时{" "}
          {runDurationText(r.startedAt, r.finishedAt)}
        </span>
      }
      onClose={props.onClose}
      footer={
        <>
          {r.conversationId ? (
            <a href={`/?conv=${r.conversationId}`} className="text-sm text-primary hover:underline">
              查看对话
            </a>
          ) : null}
          <span className="flex-1" />
          <Button variant="secondary" size="sm" onClick={props.onClose}>
            关闭
          </Button>
        </>
      }
    >
      {r.error ? (
        <div className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          失败原因：{r.error}
        </div>
      ) : null}
      <ContextBlock label="事件上下文（triggerOutput）" text={r.context} />
      <ContextBlock label="渲染后 Prompt" text={r.renderedPrompt} />
    </DialogShell>
  );
}

/** 事件卡片底部：最近触发记录（firing 维度，详情含上下文全文与本次扇出的执行轮次） */
export function EventFiringRecords(props: {
  eventId: string;
  /** workflowId → 名称（扇出轮次展示用；缺省回退短 id） */
  workflowNames?: Map<string, string>;
}) {
  const [firings, setFirings] = useState<FiringDTO[]>([]);
  const [detail, setDetail] = useState<FiringDTO | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/events/${props.eventId}/firings?limit=${MAX_ROWS}`)
      .then((r) => r.json() as Promise<{ firings?: FiringDTO[] }>)
      .then((d) => {
        if (!cancelled) setFirings(d.firings ?? []);
      })
      .catch(() => {
        if (!cancelled) setFirings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.eventId]);

  const rows = firings.slice(0, MAX_ROWS).map((f) => (
    <RecordRow
      key={f.id}
      onDetail={() => setDetail(f)}
      left={
        <>
          <Badge tone="neutral">{eventNameLabel(f.source)}</Badge>
          <span className="truncate">
            扇出 {f.matchedWorkflowCount} · {relativeTime(f.firedAt)}
          </span>
        </>
      }
    />
  ));

  return (
    <>
      <RecordSection label="最近触发" emptyText="从未触发" rows={rows} />
      {detail && (
        <FiringDetailDialog
          eventId={props.eventId}
          firing={detail}
          workflowNames={props.workflowNames}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}

function FiringDetailDialog(props: {
  eventId: string;
  firing: FiringDTO;
  workflowNames?: Map<string, string>;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<RunDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/events/${props.eventId}/firings/${props.firing.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ runs?: RunDTO[] }>;
      })
      .then((d) => {
        if (!cancelled) setRuns(d.runs ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [props.eventId, props.firing.id]);

  return (
    <DialogShell
      title="触发详情"
      subtitle={`${eventNameLabel(props.firing.source)} · ${new Date(props.firing.firedAt).toLocaleString()}`}
      onClose={props.onClose}
      footer={
        <Button variant="secondary" size="sm" onClick={props.onClose}>
          关闭
        </Button>
      }
    >
      <ContextBlock label="事件上下文" text={props.firing.context} />
      <div>
        <div className="mb-1 text-xs text-muted-foreground">本次扇出执行</div>
        {loadError ? <p className="text-xs text-destructive">加载失败：{loadError}</p> : null}
        {!loadError && runs === null ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : null}
        {runs?.length === 0 ? (
          <p className="text-xs text-muted-foreground">本次触发没有执行轮次</p>
        ) : null}
        {runs?.length ? (
          <div className="flex flex-col gap-1">
            {runs.map((run) => (
              <div key={run.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Badge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
                  <span className="truncate text-muted-foreground">
                    {props.workflowNames?.get(run.workflowId ?? "") ??
                      (run.workflowId ?? "").slice(0, 8)}
                  </span>
                </span>
                {run.conversationId ? (
                  <a
                    href={`/?conv=${run.conversationId}`}
                    className="shrink-0 text-primary hover:underline"
                  >
                    会话
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
}
