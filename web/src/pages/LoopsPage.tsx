import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
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
}

export function LoopsPage() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [wfMap, setWfMap] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
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
      .catch(() => {
        setLoops([]);
        setWfMap({});
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (l: Loop, next: boolean) => {
    setLoops((cur) => cur.map((x) => (x.id === l.id ? { ...x, enabled: next } : x)));
    const action = next ? "enable" : "disable";
    const r = await apiFetch(`/api/loops/${l.id}/${action}`, { method: "POST" });
    if (!r.ok) {
      window.alert(`操作失败：HTTP ${r.status}`);
      setLoops((cur) => cur.map((x) => (x.id === l.id ? { ...x, enabled: l.enabled } : x)));
    }
  };

  const del = async (id: string) => {
    if (!window.confirm("删除该 LOOP？")) return;
    const r = await apiFetch(`/api/loops/${id}`, { method: "DELETE" });
    if (!r.ok) window.alert(`删除失败：HTTP ${r.status}`);
    refresh();
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="LOOP 循环任务"
        description="周期性自我驱动的任务循环"
        actions={<Button onClick={() => setShowCreate(true)}>+ 新建 LOOP</Button>}
      />

      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">名称</th>
              <th className="px-4 py-2.5 font-medium">Workflow</th>
              <th className="px-4 py-2.5 font-medium">启用</th>
              <th className="px-4 py-2.5 font-medium">上次运行</th>
              <th className="px-4 py-2.5 font-medium">标签</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
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
                <td className="px-4 py-3 text-muted-foreground">
                  {l.lastRunAt ? new Date(l.lastRunAt).toLocaleString() : "—"}
                  {l.lastError && (
                    <span className="ml-1.5 text-destructive" title={l.lastError}>
                      ⚠
                    </span>
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
                    onClick={() => void del(l.id)}
                    className="text-xs text-destructive hover:underline"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !loops.length ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            暂无 LOOP，点击右上角「新建 LOOP」
          </div>
        ) : null}
      </Card>

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

  const submit = async () => {
    if (!name || !workflowId) {
      window.alert("名称和 workflow 必填");
      return;
    }
    setSaving(true);
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
      else window.alert(await r.text());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/40">
      <div className="w-96 rounded-xl bg-card p-5 shadow-xl">
        <h2 className="mb-4 text-base font-semibold">新建 LOOP</h2>
        <div className="mb-3">
          <span className="mb-1.5 block text-xs font-medium">名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="mb-3">
          <span className="mb-1.5 block text-xs font-medium">Workflow</span>
          <select
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm focus:border-primary focus:outline-none"
          >
            <option value="">— 选择 —</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-5">
          <span className="mb-1.5 block text-xs font-medium">标签（逗号分隔）</span>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ops,daily" />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="button" onClick={submit} disabled={saving}>
            创建
          </Button>
        </div>
      </div>
    </div>
  );
}
