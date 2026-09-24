import { Fragment, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { Switch } from "../components/ui/switch";
import { apiFetch } from "../lib/auth";

interface Loop {
  id: string;
  name: string;
  workflowId: string;
  enabled: boolean;
  tags?: string[];
  lastRunAt?: string | null;
  lastError?: string | null;
}

interface Workflow {
  id: string;
  name: string;
  agentId: string;
}

interface LoopRun {
  id: string;
  status: "running" | "success" | "failed" | "stopped";
  triggerOutput?: string | null;
  renderedPrompt?: string | null;
  agentConversationId?: string | null;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

const STATUS_TONE: Record<LoopRun["status"], "info" | "success" | "danger" | "neutral"> = {
  running: "info",
  success: "success",
  failed: "danger",
  stopped: "neutral",
};

const STATUS_LABEL: Record<LoopRun["status"], string> = {
  running: "运行中",
  success: "成功",
  failed: "失败",
  stopped: "已停止",
};

export function LoopDetailPage() {
  const { id } = useParams();
  const [loop, setLoop] = useState<Loop | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const refresh = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setLoadError("");
    Promise.all([
      apiFetch(`/api/loops/${id}`).then((r) => r.json() as Promise<Loop>),
      apiFetch(`/api/loops/${id}/runs`).then((r) => r.json() as Promise<{ runs?: LoopRun[] }>),
    ])
      .then(async ([l, rd]) => {
        setLoop(l);
        setRuns(rd.runs ?? []);
        if (l.workflowId) {
          const wfResp = await apiFetch(`/api/workflows/${l.workflowId}`);
          if (wfResp.ok) setWorkflow((await wfResp.json()) as Workflow);
        }
      })
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (next: boolean) => {
    if (!loop) return;
    setLoop({ ...loop, enabled: next });
    const action = next ? "enable" : "disable";
    const r = await apiFetch(`/api/loops/${loop.id}/${action}`, { method: "POST" });
    if (!r.ok) {
      setNotice({ type: "error", text: `操作失败：HTTP ${r.status}` });
      if (loop) setLoop({ ...loop, enabled: !next });
    }
  };

  const runNow = async () => {
    if (!loop) return;
    setRunning(true);
    try {
      const r = await apiFetch(`/api/loops/${loop.id}/run`, { method: "POST" });
      if (!r.ok) {
        const body = await r.text();
        setNotice({ type: "error", text: `运行失败：${r.status} ${body}` });
      } else {
        setNotice({ type: "success", text: "已触发，几秒后刷新查看新 run" });
        setTimeout(refresh, 2000);
      }
    } finally {
      setRunning(false);
    }
  };

  if (loadError && !loop) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-7">
        <div className="flex flex-col items-start gap-3 rounded-lg bg-destructive-soft p-4">
          <p className="text-sm font-medium text-destructive">加载失败：{loadError}</p>
          <Button variant="ghost" size="sm" onClick={refresh}>
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (!loop) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-7" aria-hidden="true">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const successCount = runs.filter((r) => r.status === "success").length;
  const failedCount = runs.filter((r) => r.status === "failed").length;

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title={loop.name}
        description={`Workflow：${
          workflow ? workflow.name : loop.workflowId
        } · 上次运行 ${loop.lastRunAt ? new Date(loop.lastRunAt).toLocaleString() : "—"}`}
        actions={
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              启用
              <Switch checked={loop.enabled} onCheckedChange={toggle} />
            </div>
            <Button variant="secondary" onClick={runNow} disabled={running}>
              立即运行一轮
            </Button>
          </>
        }
      />

      {notice ? (
        <div
          className={`rounded-lg px-4 py-2.5 text-sm ${
            notice.type === "error"
              ? "bg-destructive-soft text-destructive"
              : "bg-success-soft text-success"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {loop.lastError ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-3 text-sm text-destructive">
          {loop.lastError}
        </div>
      ) : null}

      {/* 统计卡：数值卡与文字状态卡（徽标表达）分列 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card className="flex flex-col gap-1.5 p-4">
          <span className="text-[22px] font-bold leading-7 text-primary">{runs.length}</span>
          <span className="text-xs text-muted-foreground">总轮次</span>
        </Card>
        <Card className="flex flex-col gap-1.5 p-4">
          <span className="text-[22px] font-bold leading-7 text-success">{successCount}</span>
          <span className="text-xs text-muted-foreground">成功</span>
        </Card>
        <Card className="flex flex-col gap-1.5 p-4">
          <span className="text-[22px] font-bold leading-7 text-destructive">{failedCount}</span>
          <span className="text-xs text-muted-foreground">失败</span>
        </Card>
        <Card className="flex flex-col gap-1.5 p-4">
          <Badge tone={loop.enabled ? "success" : "neutral"} className="w-fit">
            {loop.enabled ? "运行中" : "已暂停"}
          </Badge>
          <span className="text-xs text-muted-foreground">状态</span>
        </Card>
      </div>

      {(loop.tags?.length ?? 0) > 0 ? (
        <div className="flex gap-1.5">
          {loop.tags?.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      ) : null}

      <h2 className="text-base font-semibold">最近轮次</h2>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">开始时间</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">触发输出</th>
                <th className="px-4 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    className="cursor-pointer border-t border-border hover:bg-muted/40"
                    onClick={() => setExpandedRun((cur) => (cur === r.id ? null : r.id))}
                  >
                    <td className="px-4 py-3">{new Date(r.startedAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </td>
                    <td className="max-w-md truncate px-4 py-3 text-muted-foreground">
                      {r.error ?? r.triggerOutput ?? ""}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.agentConversationId && (
                        <Link
                          to={`/?conv=${r.agentConversationId}`}
                          className="text-xs text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          跳会话
                        </Link>
                      )}
                    </td>
                  </tr>
                  {expandedRun === r.id && (
                    <tr className="border-t border-border bg-muted/30">
                      <td colSpan={4} className="p-4">
                        {r.error && (
                          <div className="mb-2 text-sm text-destructive">
                            <strong>错误：</strong>
                            {r.error}
                          </div>
                        )}
                        <div className="mb-1 text-xs text-muted-foreground">renderedPrompt:</div>
                        <pre className="max-h-60 overflow-auto rounded-lg bg-card p-3 text-xs">
                          {r.renderedPrompt ?? ""}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!runs.length ? (
          <div className="p-10 text-center text-sm text-muted-foreground">还没有运行记录</div>
        ) : null}
      </Card>
    </div>
  );
}
