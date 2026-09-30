import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { apiFetchRetry } from "../lib/auth";
import { BUILTIN_APP_MANAGER_ID } from "../lib/builtinAgents";

export interface ProxyChannelView {
  service: string;
  connectorId: string;
  connectorName: string | null;
  authStyle: "none" | "basic-crumb" | "token-login" | null;
  status: "ready" | "credential-missing" | "unavailable";
  missingCredentials: string[];
}

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
  managerAgentId: string | null;
  steward: { agentId: string; name: string } | null;
  proxyChannels?: ProxyChannelView[];
  /** 分享面（分发面 §7.2）：仅属主视图携带 */
  shareGrants?: string[];
  shareGrantsUsers?: Array<{ id: string; name: string }>;
}

/** 被分享者最小视图（服务端 sharedAppView；无管理面字段，也无属主 id） */
export interface SharedAppView {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  access: string;
  currentVersion: number | null;
  updatedAt: string;
  runPath: string | null;
}

export const ACCESS_LABEL: Record<string, string> = {
  private: "私有",
  grants: "名单授权",
  "all-users": "全体用户",
  "public-anonymous": "公开匿名",
};

export function AppsPage() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<PlatformAppView[]>([]);
  const [shared, setShared] = useState<SharedAppView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiFetchRetry("/api/apps")
      .then((r) => r.json() as Promise<{ apps?: PlatformAppView[]; shared?: SharedAppView[] }>)
      .then((d) => {
        setApps(d.apps ?? []);
        setShared(d.shared ?? []);
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
        description="由智能体在平台内开发并发布的个人应用"
        actions={
          <Button onClick={() => navigate(`/?agent=${BUILTIN_APP_MANAGER_ID}`)}>应用管家</Button>
        }
      />

      {error ? (
        <div className="rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}

      {!loading && !apps.length && !shared.length ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          暂无应用。点击右上角「应用管家」对话描述需求，由智能体完成开发与发布；或按
          <Link to="/skills" className="mx-1 text-primary hover:underline">
            app-develop 技能
          </Link>
          使用任意 coding 智能体。
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
                  <Link
                    to={`/apps/${a.id}?tab=run`}
                    className="text-xs text-primary hover:underline"
                  >
                    打开
                  </Link>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {shared.length ? (
        <>
          <h2 className="mt-2 text-sm font-semibold text-muted-foreground">分享给我的</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shared.map((a) => (
              <Card key={a.id} className="flex flex-col gap-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold">{a.name}</span>
                  <Badge tone="info">{ACCESS_LABEL[a.access] ?? a.access}</Badge>
                </div>
                <p className="line-clamp-2 min-h-10 text-xs text-muted-foreground">
                  {a.description || "（无描述）"}
                </p>
                <div className="mt-auto flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    {a.currentVersion !== null ? `已发布 v${a.currentVersion}` : "未发布产物"}
                  </span>
                  {a.currentVersion !== null ? (
                    <Link
                      to={`/apps/${a.id}/open`}
                      className="text-xs text-primary hover:underline"
                    >
                      打开
                    </Link>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
