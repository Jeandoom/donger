import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { EventFiringRecords } from "../components/AutomationRecords";
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
  const [workflowNames, setWorkflowNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EventDTO | null>(null);

  const refresh = useCallback(() => {
    // workflowNames 供触发详情展示扇出轮次的工作流名称（同属主列表，一次取全）
    void Promise.all([
      apiFetch("/api/events").then((r) => r.json() as Promise<{ events?: EventDTO[] }>),
      apiFetch("/api/workflows").then(
        (r) => r.json() as Promise<{ workflows?: Array<{ id: string; name: string }> }>,
      ),
    ])
      .then(([ev, wf]) => {
        setItems(ev.events ?? []);
        setWorkflowNames(new Map((wf.workflows ?? []).map((w) => [w.id, w.name])));
      })
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((e) => (
            <Card key={e.id} className="flex flex-col gap-2.5 p-4">
              <div className="flex items-center justify-between gap-2">
                <Link
                  to={`/events/${e.id}`}
                  className="truncate text-sm font-semibold hover:underline"
                >
                  {e.name}
                </Link>
                <Badge tone={TYPE_TONE[e.type]}>{TYPE_LABEL[e.type]}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                订阅工作流 {e.subscriberCount ?? 0} 个
                {e.nextRunAt ? (
                  <span className="ml-1">· 下次触发 {new Date(e.nextRunAt).toLocaleString()}</span>
                ) : null}
              </div>
              <div className="mt-auto flex items-center justify-end gap-1.5">
                <Link to={`/events/${e.id}`}>
                  <Button variant="secondary" size="sm">
                    编辑
                  </Button>
                </Link>
                <Button variant="danger" size="sm" onClick={() => setPendingDelete(e)}>
                  删除
                </Button>
              </div>
              <EventFiringRecords eventId={e.id} workflowNames={workflowNames} />
            </Card>
          ))}
        </div>
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
