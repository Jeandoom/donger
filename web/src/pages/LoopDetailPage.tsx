import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
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

const STATUS_COLORS: Record<LoopRun["status"], string> = {
  running: "text-blue-600",
  success: "text-green-600",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

export function LoopDetailPage() {
  const { id } = useParams();
  const [loop, setLoop] = useState<Loop | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(() => {
    if (!id) return;
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
      .catch(() => setLoop(null));
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
      window.alert(`操作失败：HTTP ${r.status}`);
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
        window.alert(`运行失败：${r.status} ${body}`);
      } else {
        window.alert("已触发，几秒后刷新查看新 run");
        setTimeout(refresh, 2000);
      }
    } finally {
      setRunning(false);
    }
  };

  if (!loop) return <div className="p-4 text-muted-foreground">加载中…</div>;

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold">{loop.name}</h1>
        <Switch checked={loop.enabled} onCheckedChange={toggle} />
        <Button type="button" variant="outline" onClick={runNow} disabled={running}>
          立即运行
        </Button>
      </div>
      <div className="mb-4 text-sm text-muted-foreground">
        <div>
          Workflow:{" "}
          {workflow ? (
            <Link to={`/workflows/${workflow.id}`} className="hover:underline">
              {workflow.name}
            </Link>
          ) : (
            loop.workflowId
          )}
        </div>
        <div>
          上次运行：{loop.lastRunAt ? new Date(loop.lastRunAt).toLocaleString() : "—"}
          {loop.lastError && <span className="ml-2 text-destructive">{loop.lastError}</span>}
        </div>
        {(loop.tags?.length ?? 0) > 0 && <div>标签：{loop.tags?.join(", ")}</div>}
      </div>

      <h2 className="mb-2 text-sm font-semibold">运行历史（最近 50）</h2>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">开始时间</th>
            <th className="text-left">状态</th>
            <th className="text-left">触发输出</th>
            <th aria-label="actions"></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <>
              <tr
                key={r.id}
                className="cursor-pointer border-t"
                onClick={() => setExpandedRun((cur) => (cur === r.id ? null : r.id))}
              >
                <td className="py-2">{new Date(r.startedAt).toLocaleString()}</td>
                <td className={STATUS_COLORS[r.status]}>{r.status}</td>
                <td className="max-w-md truncate text-muted-foreground">
                  {r.error ?? r.triggerOutput ?? ""}
                </td>
                <td className="text-right">
                  {r.agentConversationId && (
                    <Link
                      to={`/?conv=${r.agentConversationId}`}
                      className="text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      跳会话
                    </Link>
                  )}
                </td>
              </tr>
              {expandedRun === r.id && (
                <tr key={`${r.id}-detail`} className="border-t bg-muted/30">
                  <td colSpan={4} className="p-3">
                    {r.error && (
                      <div className="mb-2 text-destructive">
                        <strong>错误：</strong>
                        {r.error}
                      </div>
                    )}
                    <div className="mb-1 text-xs text-muted-foreground">renderedPrompt:</div>
                    <pre className="max-h-60 overflow-auto bg-background p-2 text-xs">
                      {r.renderedPrompt ?? ""}
                    </pre>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
