import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import { apiFetch } from "../lib/auth";

interface Workflow {
  id: string;
  name: string;
  description?: string;
  triggerId: string;
  agentId: string;
}

export function WorkflowsPage() {
  const [items, setItems] = useState<Workflow[]>([]);

  const refresh = useCallback(() => {
    apiFetch("/api/workflows")
      .then((r) => r.json() as Promise<{ workflows?: Workflow[] }>)
      .then((data) => setItems(data.workflows ?? []))
      .catch(() => setItems([]));
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
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">工作流管理</h1>
        <Link to="/workflows/new">
          <Button type="button">新建</Button>
        </Link>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">名称</th>
            <th className="text-left">描述</th>
            <th aria-label="actions"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id} className="border-t">
              <td className="py-2">
                <Link to={`/workflows/${w.id}`} className="hover:underline">
                  {w.name}
                </Link>
              </td>
              <td className="text-muted-foreground">{w.description ?? ""}</td>
              <td className="text-right">
                <button
                  type="button"
                  onClick={() => del(w.id)}
                  className="text-destructive hover:underline"
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
