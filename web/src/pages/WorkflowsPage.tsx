import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
import { Switch } from "../components/ui/switch";
import { apiFetch } from "../lib/auth";

interface Workflow {
  id: string;
  name: string;
  description?: string;
  eventId: string;
  agentId: string;
  enabled: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
}

function relativeTime(iso?: string | null): string {
  if (!iso) return "从未运行";
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString();
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<Workflow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiFetch("/api/workflows")
      .then((r) => r.json() as Promise<{ workflows?: Workflow[] }>)
      .then((data) => setItems(data.workflows ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const del = async (id: string) => {
    const r = await apiFetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (!r.ok) setNotice(`删除失败：HTTP ${r.status}`);
    setPendingDelete(null);
    refresh();
  };

  const toggle = async (w: Workflow, next: boolean) => {
    setItems((list) => list.map((x) => (x.id === w.id ? { ...x, enabled: next } : x)));
    const r = await apiFetch(`/api/workflows/${w.id}/${next ? "enable" : "disable"}`, {
      method: "POST",
    });
    if (!r.ok) {
      setNotice(`操作失败：HTTP ${r.status}`);
      refresh();
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="工作流"
        description="订阅事件驱动智能体执行；启用后由事件自动触发"
        actions={<Button onClick={() => navigate("/workflows/new")}>+ 新建工作流</Button>}
      />

      {notice ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {notice}
        </div>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}

      {items.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((w) => (
            <Card key={w.id} className="flex flex-col gap-2.5 p-4">
              <div className="flex items-center justify-between gap-2">
                <Link
                  to={`/workflows/${w.id}`}
                  className="truncate text-sm font-semibold hover:underline"
                >
                  {w.name}
                </Link>
                <Badge tone={w.enabled ? "success" : "neutral"}>
                  {w.enabled ? "已启用" : "已停用"}
                </Badge>
              </div>
              <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                {w.description || "—"}
              </p>
              <div className="text-xs text-muted-foreground">
                最近执行：{relativeTime(w.lastRunAt)}
                {w.lastError ? (
                  <span className="ml-1 text-destructive">（失败：{w.lastError.slice(0, 60)}）</span>
                ) : null}
              </div>
              <div className="mt-auto flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  启用
                  <Switch checked={w.enabled} onCheckedChange={(v) => void toggle(w, v)} />
                </div>
                <div className="flex gap-1.5">
                  <Link to={`/workflows/${w.id}`}>
                    <Button variant="secondary" size="sm">
                      编辑
                    </Button>
                  </Link>
                  <Button variant="danger" size="sm" onClick={() => setPendingDelete(w)}>
                    删除
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        !loading && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            暂无工作流，点击右上角「新建工作流」开始编排
          </div>
        )
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除工作流「${pendingDelete?.name ?? ""}」？`}
        description="删除后不可恢复，其执行记录一并删除。"
        confirmText="删除"
        destructive
        onConfirm={() => void del(pendingDelete?.id ?? "")}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
