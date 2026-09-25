import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Textarea } from "../components/ui/textarea";
import { apiFetch, apiFetchRetry } from "../lib/auth";

export interface PlatformAppView {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  manifest: { runtime: string; ui: { spa: boolean }; access: string };
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
  runPath: string | null;
}

export function AppsPage() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<PlatformAppView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => {
    apiFetchRetry("/api/apps")
      .then((r) => r.json() as Promise<{ apps?: PlatformAppView[] }>)
      .then((d) => {
        setApps(d.apps ?? []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="应用"
        description="由智能体开发并发布到平台的个人应用"
        actions={<Button onClick={() => setShowCreate(true)}>+ 新建应用</Button>}
      />

      {error ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}

      {!loading && !apps.length ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          暂无应用。在会话中让智能体开发应用并发布，或点击右上角「新建应用」手动上传。
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {apps.map((a) => (
          <Card key={a.id} className="flex flex-col gap-3 p-5">
            <div className="flex items-start justify-between gap-2">
              <Link to={`/apps/${a.id}`} className="text-sm font-semibold hover:underline">
                {a.name}
              </Link>
              <Badge>{a.manifest.runtime}</Badge>
            </div>
            <p className="line-clamp-2 min-h-10 text-xs text-muted-foreground">
              {a.description || "（无描述）"}
            </p>
            <div className="mt-auto flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">
                {a.currentVersion !== null ? `已发布 v${a.currentVersion}` : "未发布产物"}
              </span>
              <div className="flex gap-2">
                <Link
                  to={`/apps/${a.id}`}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  详情
                </Link>
                {a.runPath ? (
                  <Link to={`/apps/${a.id}?tab=run`} className="text-xs text-primary hover:underline">
                    打开
                  </Link>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {showCreate ? (
        <CreateAppDialog
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/apps/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateAppDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("名称必填");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await apiFetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          manifest: { manifestVersion: 1, runtime: "static", ui: { spa: true }, access: "private" },
        }),
      });
      if (r.ok) {
        const d = (await r.json()) as { app?: { id: string } };
        if (d.app?.id) onCreated(d.app.id);
        else onClose();
      } else {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `创建失败：HTTP ${r.status}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-xl bg-card p-5 shadow-xl">
        <h2 className="mb-4 text-base font-semibold">新建应用</h2>
        <div className="mb-3">
          <span className="mb-1.5 block text-xs font-medium">名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="板块监控台" />
        </div>
        <div className="mb-5">
          <span className="mb-1.5 block text-xs font-medium">描述</span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话描述应用用途"
            rows={3}
          />
        </div>
        <p className="mb-3 rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
          创建后在详情页上传静态 bundle（zip，含 index.html）；也可在会话中让智能体完成开发并发布。
        </p>
        {error ? (
          <div className="mb-3 rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="button" onClick={submit} disabled={saving}>
            {saving ? "创建中…" : "创建"}
          </Button>
        </div>
      </div>
    </div>
  );
}
