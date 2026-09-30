import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { DialogShell } from "../components/ui/dialog-shell";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { apiFetch, apiFetchRetry } from "../lib/auth";
import { type ConnectorDTO, fetchConnectors } from "../lib/connectors";
import { ACCESS_LABEL, type PlatformAppView, type ProxyChannelView } from "./AppsPage";

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

type Tab = "overview" | "versions" | "channels" | "data" | "logs" | "run";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "versions", label: "版本" },
  { key: "channels", label: "通道" },
  { key: "data", label: "数据" },
  { key: "logs", label: "日志" },
  { key: "run", label: "运行" },
];

const AUTH_STYLE_LABEL: Record<string, string> = {
  none: "静态头",
  "basic-crumb": "Basic+Crumb",
  "token-login": "登录换令牌",
};

interface AppLogItem {
  id: number;
  source: "gateway" | "frontend";
  level: "info" | "warn" | "error";
  method?: string;
  path?: string;
  status?: number;
  message?: string;
  ts: string;
}

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
  const [shareOpen, setShareOpen] = useState(false);
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [stewardSaving, setStewardSaving] = useState(false);
  const tab = (params.get("tab") as Tab | null) ?? "overview";

  useEffect(() => {
    fetchAgents()
      .then((list) =>
        setAgents(
          list.filter((a) => a.id !== "builtin-dispatcher" && a.id !== "builtin-app-manager"),
        ),
      )
      .catch(() => {});
  }, []);

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

  // 管家改派（应用管家制 spec §8）：空值=交还内置应用管家兜底
  const reassign = async (agentId: string) => {
    if (!appId) return;
    setStewardSaving(true);
    try {
      const r = await apiFetch(`/api/apps/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ managerAgentId: agentId || null }),
      });
      if (r.ok) await refresh();
      else {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setNotice(`改派失败：${d.error ?? `HTTP ${r.status}`}`);
      }
    } finally {
      setStewardSaving(false);
    }
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
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-muted/60"
            >
              分享
            </button>
            <Link
              to={`/feedback?app=${app.id}`}
              className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-muted/60"
            >
              反馈
            </Link>
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
          <Row
            label="访问范围"
            value={
              <span>
                {ACCESS_LABEL[app.manifest.access] ?? app.manifest.access}
                {app.manifest.access === "grants"
                  ? `（${app.shareGrantsUsers?.length ?? 0} 人）`
                  : null}
                {app.manifest.access !== "private" ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    被分享者仅可运行（数据只读、代理仅 GET）
                  </span>
                ) : null}
              </span>
            }
          />
          <Row
            label="责任管家"
            value={
              <select
                value={app.managerAgentId ?? ""}
                onChange={(e) => void reassign(e.target.value)}
                disabled={stewardSaving}
                className="max-w-56 rounded-md border border-border bg-card px-2 py-1 text-xs"
              >
                <option value="">内置应用管家（兜底）</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            }
          />
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
      {tab === "channels" ? (
        <ChannelsTab appId={app.id} channels={app.proxyChannels ?? []} onChanged={refresh} />
      ) : null}
      {tab === "data" ? <DataTab appId={app.id} /> : null}
      {tab === "logs" ? <LogsTab appId={app.id} /> : null}
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

      {shareOpen ? (
        <ShareDialog
          app={app}
          onClose={() => setShareOpen(false)}
          onChanged={() => {
            setShareOpen(false);
            refresh();
          }}
        />
      ) : null}
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

/** 分享四档（分发面 spec §7.2）：access 档位 + grants 名单编辑 */
const SHARE_ACCESS_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: "private", label: "私有", desc: "仅本人可打开（默认）" },
  { value: "grants", label: "名单授权", desc: "名单内用户登录后可打开；数据只读、代理仅 GET" },
  { value: "all-users", label: "全体用户", desc: "平台内所有登录用户可打开；数据只读、代理仅 GET" },
  {
    value: "public-anonymous",
    label: "公开匿名",
    desc: "任何持有链接者免登录可打开；数据只读、代理仅 GET",
  },
];

function ShareDialog({
  app,
  onClose,
  onChanged,
}: {
  app: PlatformAppView;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [access, setAccess] = useState<string>(app.manifest.access);
  const [grants, setGrants] = useState<Array<{ id: string; name: string }>>(
    app.shareGrantsUsers ?? [],
  );
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 候选搜索：300ms 防抖；过滤已在名单内的用户
  useEffect(() => {
    if (access !== "grants") return;
    const t = setTimeout(() => {
      apiFetch(`/api/apps/${app.id}/grant-candidates?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d: { users?: Array<{ id: string; name: string }> }) =>
          setCandidates(
            (d.users ?? []).filter((u) => !grants.some((g) => g.id === u.id)),
          ),
        )
        .catch(() => setCandidates([]));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, access, app.id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/apps/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest: { ...app.manifest, access },
          shareGrants: grants.map((g) => g.id),
        }),
      });
      if (r.ok) {
        onChanged();
      } else {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `保存失败：HTTP ${r.status}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = `${window.location.origin}/apps/${app.id}/open`;
  return (
    <DialogShell
      title={`分享「${app.name}」`}
      subtitle="被分享者仅可运行应用：运行数据只读、出网代理仅 GET，凭证永不离开服务端"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-muted/60"
          >
            取消
          </button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2">
          {SHARE_ACCESS_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${
                access === o.value ? "border-primary bg-primary-soft" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="share-access"
                className="mt-0.5"
                checked={access === o.value}
                onChange={() => setAccess(o.value)}
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {access === "grants" ? (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
            <div className="flex flex-wrap gap-1.5">
              {grants.map((g) => (
                <span
                  key={g.id}
                  className="flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-xs shadow-sm"
                >
                  {g.name}
                  <button
                    type="button"
                    aria-label={`移除 ${g.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setGrants(grants.filter((x) => x.id !== g.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {!grants.length ? (
                <span className="text-xs text-muted-foreground">名单为空——保存后无人可访问</span>
              ) : null}
            </div>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="按用户名/ID 搜索平台用户…"
            />
            {candidates.length ? (
              <div className="flex flex-col gap-1">
                {candidates.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="rounded px-2 py-1 text-left text-xs hover:bg-muted"
                    onClick={() => {
                      setGrants([...grants, u]);
                      setCandidates(candidates.filter((c) => c.id !== u.id));
                      setQ("");
                    }}
                  >
                    {u.name}
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                      {u.id}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {access !== "private" ? (
          <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">访问链接</div>
            <code className="break-all font-mono">{shareUrl}</code>
            <div className="mt-1">
              {access === "public-anonymous"
                ? "任何持有该链接者均可打开；收回分享（改回私有）后已签发令牌最多 60 分钟内失效。"
                : "链接仅对被授权的登录用户生效。"}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
}

/**
 * 出网通道（spec 2026-09-29-app-proxy-credential-binding §3）：
 * 服务名（bundle 里的通道别名）→ type=http 连接器绑定；凭证按应用属主在服务端解析。
 */
function ChannelsTab({
  appId,
  channels,
  onChanged,
}: {
  appId: string;
  channels: ProxyChannelView[];
  onChanged: () => void;
}) {
  const [connectors, setConnectors] = useState<ConnectorDTO[]>([]);
  const [service, setService] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchConnectors()
      .then((list) =>
        setConnectors(
          list.filter(
            (c) => c.type === "http" && c.enabled && (c.createdByMe || c.shareScope === "global"),
          ),
        ),
      )
      .catch(() => {});
  }, []);

  const saveBindings = async (bindings: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/apps/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyBindings: bindings }),
      });
      if (r.ok) {
        setService("");
        setConnectorId("");
        onChanged();
      } else {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `保存失败：HTTP ${r.status}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const currentBindings = Object.fromEntries(channels.map((c) => [c.service, c.connectorId]));
  const bind = () => {
    const svc = service.trim();
    if (!svc || !connectorId) return;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(svc)) {
      setError("服务名须为小写字母开头的小写字母/数字/连字符（≤32 字符）");
      return;
    }
    void saveBindings({ ...currentBindings, [svc]: connectorId });
  };
  const unbind = (svc: string) => {
    const next = { ...currentBindings };
    delete next[svc];
    void saveBindings(next);
  };

  const statusBadge = (c: ProxyChannelView) => {
    if (c.status === "ready") return <Badge tone="success">就绪</Badge>;
    if (c.status === "credential-missing") {
      return (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone="warning">凭证未填</Badge>
          {c.missingCredentials.map((code) => (
            <Link
              key={code}
              to="/credentials"
              className="text-xs text-primary hover:underline"
              title="到凭证页填写该凭证"
            >
              {code}
            </Link>
          ))}
        </span>
      );
    }
    return <Badge tone="danger">连接器失效/停用</Badge>;
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        应用通过
        <span className="font-mono"> /api/app-proxy/&lt;appId&gt;/&lt;服务名&gt; </span>
        出网：服务名是应用代码里的通道别名，绑定到 HTTP
        连接器后由平台按你名下的凭证在服务端注入鉴权——凭证不进应用前端。 连接器在
        <Link to="/connectors" className="mx-1 text-primary hover:underline">
          连接器
        </Link>
        页创建；凭证在
        <Link to="/credentials" className="mx-1 text-primary hover:underline">
          凭证
        </Link>
        页填写。
      </p>

      {error ? (
        <div className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">服务名</th>
              <th className="px-4 py-2.5 font-medium">连接器</th>
              <th className="px-4 py-2.5 font-medium">认证</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.service} className="border-t border-border">
                <td className="px-4 py-3 font-mono text-xs">{c.service}</td>
                <td className="px-4 py-3">
                  {c.connectorName ?? (
                    <span className="font-mono text-xs text-muted-foreground">{c.connectorId}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {c.authStyle ? (AUTH_STYLE_LABEL[c.authStyle] ?? c.authStyle) : "—"}
                </td>
                <td className="px-4 py-3">{statusBadge(c)}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => unbind(c.service)}
                    className="text-xs text-destructive hover:underline"
                  >
                    解绑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!channels.length ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            暂无通道。在下方把应用使用的服务名绑定到连接器。
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">服务名</span>
          <input
            value={service}
            onChange={(e) => setService(e.target.value)}
            placeholder="如 jihulab / jenkins / ops"
            className="w-44 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">HTTP 连接器</span>
          <select
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
            className="max-w-64 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
          >
            <option value="">选择连接器…</option>
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.shareScope === "global" ? "（全局）" : ""} · {c.url}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" disabled={busy || !service.trim() || !connectorId} onClick={bind}>
          绑定通道
        </Button>
        {!connectors.length ? (
          <span className="text-xs text-muted-foreground">
            尚无可用 HTTP 连接器——先到「连接器」页新建。
          </span>
        ) : null}
      </Card>
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

/** 应用日志（spec 修订 2026-09-29）：网关面（页面/资产/数据 API）+ 前端面（注入采集）合并视图 */
function LogsTab({ appId }: { appId: string }) {
  const [items, setItems] = useState<AppLogItem[]>([]);
  const [source, setSource] = useState<"all" | "gateway" | "frontend">("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    apiFetchRetry(`/api/apps/${appId}/logs?limit=300`)
      .then((r) => r.json() as Promise<{ items?: AppLogItem[] }>)
      .then((d) => setItems(d.items ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [appId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const shown = items.filter((i) => source === "all" || i.source === source);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-muted/60 p-1 text-xs">
          {(
            [
              ["all", "全部"],
              ["gateway", "网关（页面/数据 API）"],
              ["frontend", "应用前端（错误采集）"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSource(key)}
              className={
                source === key
                  ? "rounded-md bg-card px-2.5 py-1 font-medium shadow-sm"
                  : "rounded-md px-2.5 py-1 text-muted-foreground hover:text-foreground"
              }
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">每 4 秒自动刷新</span>
      </div>

      <Card className="max-h-[65vh] overflow-auto bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-300">
        {loading ? <div className="text-slate-500">加载中…</div> : null}
        {!loading && !shown.length ? (
          <div className="text-slate-500">
            暂无日志。打开应用后：网关面记录页面加载与数据 API 调用；前端面自动采集应用内错误、
            资源加载失败与 console.error。
          </div>
        ) : null}
        {shown.map((i) => (
          <div key={i.id} className="whitespace-pre-wrap break-all">
            <span className="text-slate-500">[{new Date(i.ts).toLocaleTimeString()}]</span>{" "}
            <span
              className={
                i.level === "error"
                  ? "text-rose-400"
                  : i.level === "warn"
                    ? "text-amber-300"
                    : "text-sky-300"
              }
            >
              {i.level.toUpperCase().padEnd(5)}
            </span>{" "}
            <span className="text-slate-500">{i.source === "gateway" ? "gw " : "fe "}</span>
            {i.method ? <span className="text-emerald-300">{i.method} </span> : null}
            {i.path ? <span className="text-slate-100">{i.path} </span> : null}
            {i.status !== undefined ? (
              <span className={i.status >= 400 ? "text-rose-400" : "text-slate-400"}>
                {i.status}{" "}
              </span>
            ) : null}
            {i.message ? <span>{i.message}</span> : null}
          </div>
        ))}
      </Card>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
