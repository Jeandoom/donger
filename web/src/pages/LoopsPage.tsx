import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { DialogShell } from "../components/ui/dialog-shell";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
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
}

export function LoopsPage() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [wfMap, setWfMap] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      apiFetch("/api/loops").then((r) => r.json() as Promise<{ loops?: Loop[] }>),
      apiFetch("/api/workflows").then((r) => r.json() as Promise<{ workflows?: Workflow[] }>),
    ])
      .then(([ld, wd]) => {
        setLoops(ld.loops ?? []);
        const m: Record<string, string> = {};
        for (const w of wd.workflows ?? []) m[w.id] = w.name;
        setWfMap(m);
      })
      .catch((reason: unknown) => {
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const [pendingDelete, setPendingDelete] = useState<Loop | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const toggle = async (l: Loop, next: boolean) => {
    setLoops((cur) => cur.map((x) => (x.id === l.id ? { ...x, enabled: next } : x)));
    const action = next ? "enable" : "disable";
    const r = await apiFetch(`/api/loops/${l.id}/${action}`, { method: "POST" });
    if (!r.ok) {
      setNotice(`操作失败：HTTP ${r.status}`);
      setLoops((cur) => cur.map((x) => (x.id === l.id ? { ...x, enabled: l.enabled } : x)));
    }
  };

  const del = async (id: string) => {
    setDeleting(true);
    const r = await apiFetch(`/api/loops/${id}`, { method: "DELETE" });
    if (!r.ok) setNotice(`删除失败：HTTP ${r.status}`);
    setDeleting(false);
    setPendingDelete(null);
    refresh();
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="LOOP 循环任务"
        description="周期性自我驱动的任务循环"
        actions={<Button onClick={() => setShowCreate(true)}>+ 新建 LOOP</Button>}
      />

      {notice ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {notice}
        </div>
      ) : null}
      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          <span>LOOP 列表加载失败：{loadError}</span>
          <Button variant="secondary" size="sm" onClick={refresh}>
            重试
          </Button>
        </div>
      ) : null}
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : null}

      {!loading ? (
        <Card className="overflow-hidden">
          {/* 窄屏横向滚动，避免 6 列表格挤压成逐字竖排 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">名称</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">Workflow</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">启用</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">上次运行</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">标签</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {loops.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <Link to={`/loops/${l.id}`} className="font-medium hover:underline">
                        {l.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {wfMap[l.workflowId] ?? l.workflowId}
                    </td>
                    <td className="px-4 py-3">
                      <Switch checked={l.enabled} onCheckedChange={(v) => void toggle(l, v)} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {l.lastRunAt ? new Date(l.lastRunAt).toLocaleString() : "—"}
                      {l.lastError && (
                        <Badge tone="danger" className="ml-1.5" title={l.lastError}>
                          出错
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(l.tags ?? []).map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/loops/${l.id}`} className="mr-2 text-xs hover:underline">
                        详情
                      </Link>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(l)}
                        className="text-xs text-destructive hover:underline"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !loops.length && !loadError ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              暂无 LOOP，点击右上角「新建 LOOP」
            </div>
          ) : null}
        </Card>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除 LOOP「${pendingDelete?.name ?? ""}」？`}
        description="删除后不可恢复。"
        confirmText="删除"
        destructive
        busy={deleting}
        onConfirm={() => void del(pendingDelete?.id ?? "")}
        onCancel={() => (deleting ? undefined : setPendingDelete(null))}
      />

      {showCreate && (
        <CreateLoopDialog
          workflows={Object.entries(wfMap).map(([id, name]) => ({ id, name }))}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateLoopDialog({
  workflows,
  onClose,
  onCreated,
}: {
  workflows: Workflow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name || !workflowId) {
      setError("名称和 workflow 必填");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await apiFetch("/api/loops", {
        method: "POST",
        body: JSON.stringify({
          name,
          workflowId,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      if (r.ok) onCreated();
      else setError(await r.text());
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell
      title="新建 LOOP"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={saving}>
            {saving ? "创建中…" : "创建"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold">名称</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold">Workflow</span>
        <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
          <option value="">— 选择 —</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold">标签（逗号分隔）</span>
        <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ops,daily" />
      </div>
      {error ? (
        <div className="rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </DialogShell>
  );
}
