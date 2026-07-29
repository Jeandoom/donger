import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/auth";
import { Button } from "../components/ui/button";

interface Trigger {
  id: string;
  name: string;
  type: "scheduler" | "hook";
}

export function TriggersPage() {
  const [items, setItems] = useState<Trigger[]>([]);

  const refresh = useCallback(() => {
    apiFetch("/api/triggers")
      .then((r) => r.json() as Promise<{ triggers?: Trigger[] }>)
      .then((data) => setItems(data.triggers ?? []))
      .catch(() => setItems([]));
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
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">触发器管理</h1>
        <Link to="/triggers/new">
          <Button type="button">新建</Button>
        </Link>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">名称</th>
            <th className="text-left">类型</th>
            <th aria-label="actions"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id} className="border-t">
              <td className="py-2">
                <Link to={`/triggers/${t.id}`} className="hover:underline">
                  {t.name}
                </Link>
              </td>
              <td>{t.type}</td>
              <td className="text-right">
                <button
                  type="button"
                  onClick={() => del(t.id)}
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
