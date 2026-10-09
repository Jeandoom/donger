import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
import { apiFetch } from "../lib/auth";

type EventType = "system" | "schedule" | "call";

interface EventDTO {
  id: string;
  name: string;
  type: EventType;
  lastFiredAt?: string | null;
  nextRunAt?: string | null;
  subscriberCount?: number;
}

const TYPE_LABEL: Record<EventType, string> = {
  system: "系统默认",
  schedule: "定时",
  call: "调用",
};

const TYPE_TONE: Record<EventType, "primary" | "info" | "success"> = {
  system: "info",
  schedule: "primary",
  call: "success",
};

export function EventsPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<EventDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EventDTO | null>(null);

  const refresh = useCallback(() => {
    apiFetch("/api/events")
      .then((r) => r.json() as Promise<{ events?: EventDTO[] }>)
      .then((d) => setItems(d.events ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const del = async (id: string) => {
    const r = await apiFetch(`/api/events/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setNotice(body.error ?? `删除失败：HTTP ${r.status}`);
    }
    setPendingDelete(null);
    refresh();
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="事件"
        description="系统默认 / 定时 / 调用三类事件源；由工作流订阅后驱动智能体执行"
        actions={<Button onClick={() => nav("/events/new")}>+ 新建事件</Button>}
      />

      {notice ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {notice}
        </div>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}

      {items.length ? (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">名称</th>
                  <th className="px-4 py-2.5 font-medium">类型</th>
                  <th className="px-4 py-2.5 font-medium">订阅工作流</th>
                  <th className="px-4 py-2.5 font-medium">最近触发</th>
                  <th className="px-4 py-2.5 font-medium">下次触发</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} className="border-t border-border hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link to={`/events/${e.id}`} className="font-medium hover:underline">
                        {e.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={TYPE_TONE[e.type]}>{TYPE_LABEL[e.type]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{e.subscriberCount ?? 0}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {e.lastFiredAt ? new Date(e.lastFiredAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {e.nextRunAt ? new Date(e.nextRunAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <Link to={`/events/${e.id}`}>
                          <Button variant="secondary" size="sm">
                            编辑
                          </Button>
                        </Link>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setPendingDelete(e)}
                          aria-label={`删除 ${e.name}`}
                        >
                          <Trash2 aria-hidden="true" size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        !loading && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            暂无事件，点击右上角「新建事件」开始
          </div>
        )
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除事件「${pendingDelete?.name ?? ""}」？`}
        description="删除后不可恢复；被工作流订阅时无法删除。"
        confirmText="删除"
        destructive
        onConfirm={() => void del(pendingDelete?.id ?? "")}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
