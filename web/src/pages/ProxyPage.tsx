import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/page-header";
import { apiFetch } from "../lib/auth";

/**
 * 代理模块（admin，spec 2026-09-21-auth-module-design §3.6）：
 * 当前托管 GitHub OAuth 请求代理；「应用」即通过 configureGithubProxy 幂等重配，新请求立即生效。
 */

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary";

export function ProxyPage() {
  const [proxyUrl, setProxyUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(() => {
    setLoadError("");
    void apiFetch("/api/admin/proxy")
      .then(async (r) => {
        if (!r.ok) throw new Error(`加载代理配置失败：HTTP ${r.status}`);
        return (await r.json()) as { githubOauthProxyUrl?: string };
      })
      .then((data) => {
        setProxyUrl(data.githubOauthProxyUrl ?? "");
        setLoaded(true);
      })
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const apply = () => {
    setBusy(true);
    setMsg(null);
    void apiFetch("/api/admin/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubOauthProxyUrl: proxyUrl }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(data.error ?? `保存失败（HTTP ${r.status}）`);
        setMsg({
          ok: true,
          text: proxyUrl.trim()
            ? "已应用：GitHub OAuth 请求已切换至新代理（失败自动回退直连）"
            : "已应用：代理已清空，GitHub OAuth 请求走直连",
        });
      })
      .catch((reason: unknown) =>
        setMsg({ ok: false, text: reason instanceof Error ? reason.message : String(reason) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <PageHeader
        title="代理"
        description="出站请求代理配置。修改后点击「应用」立即生效，无需重启服务"
      />
      {loadError ? (
        <div className="rounded bg-destructive-soft p-3 text-sm text-destructive">{loadError}</div>
      ) : null}

      <section className="space-y-3 rounded-lg border bg-background p-5">
        <h2 className="font-medium">GitHub OAuth 代理</h2>
        <p className="text-xs text-muted-foreground">
          仅作用于 GitHub 登录/绑定请求（大陆网络直连 github.com 间歇超时时配置）；留空 = 直连
        </p>
        <label className="block space-y-1 text-sm">
          <span>代理地址</span>
          <input
            type="text"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder={loaded ? "http://127.0.0.1:7897" : "加载中…"}
            disabled={!loaded}
            className={inputClass}
          />
        </label>
        {msg ? (
          <div
            className={`rounded p-2.5 text-sm ${msg.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"}`}
          >
            {msg.text}
          </div>
        ) : null}
        <Button onClick={apply} disabled={busy || !loaded}>
          {busy ? "应用中…" : "应用"}
        </Button>
      </section>
    </div>
  );
}
