import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { getToken } from "../lib/auth";

/**
 * 应用打开页（分发面 spec §7.2）：/apps/:appId/open，独立于登录壳的公开路由。
 *
 * 签发顺序：登录态 → viewer-token（属主得 owner scope，被授权者得 viewer）；
 * 401/403 → 降级试 anonymous-token（仅 public-anonymous 应用可签发）；仍失败按
 * 登录态分流出口（未登录给登录回跳，已登录给无权提示）。刻意不走 apiFetch——
 * 其 401 自动跳登录页会打断匿名降级路径。
 */
export function AppOpenPage() {
  const { appId } = useParams();
  const [src, setSrc] = useState<string | null>(null);
  const [appName, setAppName] = useState<string>("");
  const [state, setState] = useState<"loading" | "need-login" | "forbidden" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async () => {
    if (!appId) return;
    setState("loading");
    setError(null);
    const token = getToken();
    try {
      // 第一跳：登录态签发（viewer-token 对属主/被授权者放行，含 grants/all-users）
      const authRes = await fetch(`/api/apps/${appId}/viewer-token`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (authRes.ok) {
        const d = (await authRes.json()) as { token: string; appPath: string; name?: string };
        setAppName(d.name ?? "");
        setSrc(`${d.appPath}?appToken=${encodeURIComponent(d.token)}`);
        return;
      }
      // 第二跳：匿名（仅公开应用可签发；其余 404 防探测）
      const anonRes = await fetch(`/api/apps/${appId}/anonymous-token`, { method: "POST" });
      if (anonRes.ok) {
        const d = (await anonRes.json()) as { token: string; appPath: string; name?: string };
        setAppName(d.name ?? "");
        setSrc(`${d.appPath}?appToken=${encodeURIComponent(d.token)}`);
        return;
      }
      // 401 = 未登录或登录态过期（统一送登录，回跳本页）；403 = 已登录但未被授权
      setState(authRes.status === 401 ? "need-login" : "forbidden");
    } catch {
      setState("error");
      setError("网络异常，请稍后重试");
    }
  }, [appId]);

  useEffect(() => {
    void open();
  }, [open]);

  if (src) {
    return (
      <div className="flex h-screen flex-col bg-background">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span className="truncate">{appName || "应用"}</span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              沙箱运行 · 令牌 60 分钟
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs">
            <button type="button" onClick={() => void open()} className="hover:underline">
              重新签发
            </button>
            <Link to="/apps" className="text-muted-foreground hover:underline">
              应用中心
            </Link>
          </div>
        </div>
        <iframe
          title="应用运行视图"
          src={src}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          className="min-h-0 w-full flex-1 bg-white"
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      {state === "loading" ? <div>正在签发访问令牌…</div> : null}
      {state === "need-login" ? (
        <>
          <div>该应用需要登录后访问。</div>
          <Link
            to={`/login?next=/apps/${appId}/open`}
            className="rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90"
          >
            去登录
          </Link>
        </>
      ) : null}
      {state === "forbidden" ? (
        <>
          <div>无权访问该应用：它未开放分享，或你不在这个应用的授权名单里。</div>
          <div className="flex gap-3">
            <Link
              to={`/login?next=/apps/${appId}/open`}
              className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-muted/60"
            >
              换个账号登录
            </Link>
            <Link
              to="/apps"
              className="rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90"
            >
              返回应用中心
            </Link>
          </div>
        </>
      ) : null}
      {state === "error" ? (
        <>
          <div>{error}</div>
          <Button onClick={() => void open()}>重试</Button>
        </>
      ) : null}
    </div>
  );
}
