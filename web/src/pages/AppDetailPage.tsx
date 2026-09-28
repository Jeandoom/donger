import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
import { apiFetch, apiFetchRetry } from "../lib/auth";
import type { PlatformAppView } from "./AppsPage";

interface AppVersionView {
  num: number;
  bundleBytes: number;
  bundleSha256: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  isCurrent: boolean;
}

interface AppDataItem {
  key: string;
  sizeBytes: number;
  updatedAt: string;
  valueJson?: string;
}

type Tab = "overview" | "versions" | "data" | "run";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "versions", label: "版本" },
  { key: "data", label: "数据" },
  { key: "run", label: "运行" },
];

export function AppDetailPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [app, setApp] = useState<PlatformAppView | null>(null);
  const [versions, setVersions] = useState<AppVersionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tab = (params.get("tab") as Tab | null) ?? "overview";

  const refresh = useCallback(async () => {
    if (!appId) return;
    try {
      const [ar, vr] = await Promise.all([
        apiFetchRetry(`/api/apps/${appId}`),
        apiFetchRetry(`/api/apps/${appId}/versions`),
      ]);
      if (!ar.ok) {
        setError(`加载失败：HTTP ${ar.status}`);
        setLoading(false);
        return;
      }
      const ad = (await ar.json()) as { app?: PlatformAppView };
      setApp(ad.app ?? null);
      if (vr.ok) setVersions(((await vr.json()) as { versions?: AppVersionView[] }).versions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const del = async () => {
    if (!appId) return;
    const r = await apiFetch(`/api/apps/${appId}`, { method: "DELETE" });
    if (r.ok) navigate("/apps");
    else setNotice(`删除失败：HTTP ${r.status}`);
    setConfirmDelete(false);
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-7 text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }
  if (!app) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-7 text-sm text-muted-foreground">
        <div>{error ?? "应用不存在"}</div>
        <Link to="/apps" className="text-primary hover:underline">
          返回应用列表
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title={app.name}
        description={app.description || undefined}
        actions={
          <>
            {app.runPath ? (
              <Link
                to={`/apps/${app.id}?tab=run`}
                className="rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90"
              >
                打开应用
              </Link>
            ) : null}
            <Button variant="secondary" onClick={() => setConfirmDelete(true)}>
              删除
            </Button>
          </>
        }
      />

      {notice ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex gap-1 rounded-lg bg-muted/60 p-1 text-[13px]">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={`/apps/${app.id}${t.key === "overview" ? "" : `?tab=${t.key}`}`}
            className={
              tab === t.key
                ? "rounded-md bg-card px-3 py-1.5 font-medium shadow-sm"
                : "rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground"
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "overview" ? (
        <Card className="flex flex-col gap-3 p-5 text-sm">
          <Row label="运行时" value={<Badge>{app.manifest.runtime}</Badge>} />
          <Row label="访问范围" value={<span>私有（仅本人）</span>} />
          <Row
            label="当前版本"
            value={
              app.currentVersion !== null ? (
                <span>
                  v{app.currentVersion}
                  <span className="ml-2 text-xs text-muted-foreground">{app.runPath}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">未上传产物</span>
              )
            }
          />
          <Row label="创建时间" value={<span>{new Date(app.createdAt).toLocaleString()}</span>} />
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            由「应用管家」或任意 coding
            智能体在会话中开发并发布（应用唯一发布通道）；更新需求继续在会话中提出。
          </p>
        </Card>
      ) : null}

      {tab === "versions" ? (
        <VersionsTab appId={app.id} versions={versions} onChanged={refresh} />
      ) : null}
      {tab === "data" ? <DataTab appId={app.id} /> : null}
      {tab === "run" ? <RunTab appId={app.id} published={app.currentVersion !== null} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        title={`删除应用「${app.name}」？`}
        description="应用配置、全部版本产物与数据将一并删除，不可恢复。"
        confirmText="删除"
        destructive
        onConfirm={() => void del()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      {value}
    </div>
  );
}

function VersionsTab({
  appId,
  versions,
  onChanged,
}: {
  appId: string;
  versions: AppVersionView[];
  onChanged: () => void;
}) {
  const [_error, setError] = useState<string | null>(null);

  const publish = async (num: number) => {
    const r = await apiFetch(`/api/apps/${appId}/versions/${num}/publish`, { method: "POST" });
    if (!r.ok) setError(`切换失败：HTTP ${r.status}`);
    onChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        版本由智能体在会话中发布产生（应用唯一发布通道）；在会话里继续迭代即产生新版本，此处可随时切回历史版本。
      </p>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">版本</th>
              <th className="px-4 py-2.5 font-medium">文件数</th>
              <th className="px-4 py-2.5 font-medium">解压后</th>
              <th className="px-4 py-2.5 font-medium">上传时间</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.num} className="border-t border-border">
                <td className="px-4 py-3 font-medium">v{v.num}</td>
                <td className="px-4 py-3 text-muted-foreground">{v.fileCount}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatBytes(v.totalBytes)}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(v.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  {v.isCurrent ? (
                    <Badge>当前</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">历史</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {!v.isCurrent ? (
                    <button
                      type="button"
                      onClick={() => void publish(v.num)}
                      className="text-xs text-primary hover:underline"
                    >
                      切换到此版本
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!versions.length ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            尚无版本，先上传一个 zip bundle
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function DataTab({ appId }: { appId: string }) {
  const [items, setItems] = useState<AppDataItem[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiFetchRetry(`/api/apps/${appId}/data`)
      .then((r) => r.json() as Promise<{ items?: AppDataItem[]; totalBytes?: number }>)
      .then((d) => {
        setItems(d.items ?? []);
        setTotalBytes(d.totalBytes ?? 0);
      })
      .finally(() => setLoading(false));
  }, [appId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const del = async (key: string) => {
    await apiFetch(`/api/apps/${appId}/data/${encodeURIComponent(key)}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs text-muted-foreground">
        应用运行时写入的 KV 数据（共 {items.length} 条 / {formatBytes(totalBytes)}）；应用内通过
        app-token 经 /api/app-data 读写。
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Key</th>
              <th className="px-4 py-2.5 font-medium">大小</th>
              <th className="px-4 py-2.5 font-medium">更新时间</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.key} className="border-t border-border align-top">
                <td className="px-4 py-3">
                  <button
                    type="button"
                    className="text-left font-mono text-xs hover:underline"
                    onClick={() => setExpanded(expanded === it.key ? null : it.key)}
                  >
                    {it.key}
                  </button>
                  {expanded === it.key && it.valueJson !== undefined ? (
                    <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted/60 p-2 text-[11px]">
                      {it.valueJson}
                    </pre>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{formatBytes(it.sizeBytes)}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(it.updatedAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => void del(it.key)}
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
          <div className="p-8 text-center text-sm text-muted-foreground">暂无数据</div>
        ) : null}
      </Card>
    </div>
  );
}

/** 运行视图：签发 app-token 后以 sandbox iframe 挂载（不透明源，隔离主站身份） */
function RunTab({ appId, published }: { appId: string; published: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/apps/${appId}/token`, { method: "POST" });
      if (!r.ok) {
        setError(`令牌签发失败：HTTP ${r.status}`);
        return;
      }
      const d = (await r.json()) as { token: string; appPath: string };
      setSrc(`${d.appPath}?appToken=${encodeURIComponent(d.token)}`);
    } finally {
      setLoading(false);
    }
  };

  if (!published) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        应用尚未发布产物。到「应用管家」会话中描述需求，由智能体开发并发布。
      </Card>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      {!src ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            点击打开将以受限沙箱（隔离于平台登录态）加载应用，有效期 60
            分钟，过期后回到本页重新打开。
          </p>
          <Button onClick={() => void open()} disabled={loading}>
            {loading ? "签发令牌中…" : "打开应用"}
          </Button>
          {error ? (
            <div className="rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </Card>
      ) : (
        <div className="flex min-h-[70vh] flex-1 overflow-hidden rounded-xl border border-border">
          <iframe
            title="应用运行视图"
            src={src ?? undefined}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className="h-full min-h-[70vh] w-full bg-white"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
