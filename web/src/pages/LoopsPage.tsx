import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
}

export function LoopsPage() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [wfMap, setWfMap] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);

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
      });
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
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">LOOPs</h1>
        <Button type="button" onClick={() => setShowCreate(true)}>
          新建
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">名称</th>
            <th className="text-left">Workflow</th>
            <th className="text-left">启用</th>
            <th className="text-left">上次运行</th>
            <th className="text-left">标签</th>
            <th aria-label="actions"></th>
          </tr>
        </thead>
        <tbody>
          {loops.map((l) => (
            <tr key={l.id} className="border-t">
              <td className="py-2">
                <Link to={`/loops/${l.id}`} className="hover:underline">
                  {l.name}
                </Link>
              </td>
              <td className="text-muted-foreground">{wfMap[l.workflowId] ?? l.workflowId}</td>
              <td>
                <Switch checked={l.enabled} onCheckedChange={(v) => toggle(l, v)} />
              </td>
              <td className="text-muted-foreground">
                {l.lastRunAt ? new Date(l.lastRunAt).toLocaleString() : "—"}
                {l.lastError && (
                  <span className="ml-2 text-destructive" title={l.lastError}>
                    ⚠
                  </span>
                )}
              </td>
              <td className="text-xs text-muted-foreground">{(l.tags ?? []).join(", ")}</td>
              <td className="text-right">
                <button
                  type="button"
                  onClick={() => del(l.id)}
                  className="text-destructive hover:underline"
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <div className="w-96 rounded bg-background p-4 shadow-lg">
        <h2 className="mb-3 text-lg font-semibold">新建 LOOP</h2>
        <label className="mb-2 block">
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full rounded border px-2 py-1"
          />
        </label>
        <label className="mb-2 block">
          Workflow
          <select
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            className="block w-full rounded border px-2 py-1"
          >
            <option value="">— 选择 —</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 block">
          标签（逗号分隔）
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="ops,daily"
            className="block w-full rounded border px-2 py-1"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
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
