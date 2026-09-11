import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { apiFetch } from "../lib/auth";

interface Trigger {
  id: string;
  name: string;
  type: "scheduler" | "hook";
}

export function TriggersPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    apiFetch("/api/triggers")
      .then((r) => r.json() as Promise<{ triggers?: Trigger[] }>)
      .then((data) => setItems(data.triggers ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const del = async (id: string) => {
    if (!window.confirm("删除该触发器？")) return;
    const r = await apiFetch(`/api/triggers/${id}`, { method: "DELETE" });
    if (r.status === 409) {
      window.alert("该触发器被工作流引用，请先解绑");
      return;
    }
    refresh();
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="触发器"
        description="定时 / Webhook 触发任务"
        actions={<Button onClick={() => navigate("/triggers/new")}>+ 新建触发器</Button>}
      />

      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">名称</th>
              <th className="px-4 py-2.5 font-medium">类型</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="px-4 py-3">
                  <Link to={`/triggers/${t.id}`} className="font-medium hover:underline">
                    {t.name}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={t.type === "scheduler" ? "info" : "primary"}>
                    {t.type === "scheduler" ? "定时" : "Webhook"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link to={`/triggers/${t.id}`} className="mr-2 text-xs hover:underline">
                    编辑
                  </Link>
                  <button
                    type="button"
                    onClick={() => void del(t.id)}
                    className="text-xs text-destructive hover:underline"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !items.length ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            暂无触发器，点击右上角「新建触发器」
          </div>
        ) : null}
      </Card>
    </div>
  );
}
