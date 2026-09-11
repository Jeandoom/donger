import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { apiFetch } from "../lib/auth";

interface Workflow {
  id: string;
  name: string;
  description?: string;
  triggerId: string;
  agentId: string;
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);

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
    if (!window.confirm("删除该工作流？")) return;
    const r = await apiFetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (!r.ok) window.alert(`删除失败：HTTP ${r.status}`);
    refresh();
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="工作流"
        description="多步骤任务编排，串联智能体与审批"
        actions={<Button onClick={() => navigate("/workflows/new")}>+ 新建工作流</Button>}
      />

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
                <Badge tone="info">编排</Badge>
              </div>
              <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                {w.description || "—"}
              </p>
              <div className="mt-auto flex items-center justify-between">
                <Badge tone="primary">触发 → Agent</Badge>
                <div className="flex gap-1.5">
                  <Link to={`/workflows/${w.id}`}>
                    <Button variant="secondary" size="sm">
                      编辑
                    </Button>
                  </Link>
                  <Button variant="danger" size="sm" onClick={() => void del(w.id)}>
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
    </div>
  );
}
