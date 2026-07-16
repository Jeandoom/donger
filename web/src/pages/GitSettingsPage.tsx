import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  deleteGitConnection,
  fetchGitConnections,
  type GitConnectionDTO,
  type GitProvider,
  saveGitPat,
  startGitOAuth,
} from "../lib/gitSettings";

const PROVIDERS: Array<{ id: GitProvider; label: string }> = [
  { id: "github", label: "GitHub" },
  { id: "gitee", label: "Gitee" },
  { id: "jihulab", label: "极狐 GitLab" },
];

export function GitSettingsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [connections, setConnections] = useState<GitConnectionDTO[]>([]);
  const [oauthConfigured, setOauthConfigured] = useState<Record<GitProvider, boolean>>({
    github: false,
    gitee: false,
    jihulab: false,
  });
  const [tokens, setTokens] = useState<Partial<Record<GitProvider, string>>>({});
  const [busy, setBusy] = useState<GitProvider>();
  const [error, setError] = useState("");
  const returnTo = params.get("returnTo") ?? "/settings/git";

  const reload = useCallback(async (): Promise<void> => {
    const data = await fetchGitConnections();
    setConnections(data.connections);
    setOauthConfigured(data.oauthConfigured);
  }, []);

  useEffect(() => {
    void reload().catch((reason: unknown) => setError(String(reason)));
  }, [reload]);

  async function savePat(provider: GitProvider): Promise<void> {
    setBusy(provider);
    setError("");
    try {
      await saveGitPat(provider, tokens[provider] ?? "");
      setTokens((current) => ({ ...current, [provider]: "" }));
      await reload();
      navigate(returnTo, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">Git 配置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          连接仅属于当前用户；使用共享智能体时不会继承创建者的 Git 凭证。
        </p>
      </div>
      {error ? <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
      <div className="grid gap-4 md:grid-cols-3">
        {PROVIDERS.map((provider) => {
          const connection = connections.find((item) => item.provider === provider.id);
          return (
            <section key={provider.id} className="space-y-3 rounded-lg border bg-background p-4">
              <h2 className="font-medium">{provider.label}</h2>
              {connection ? (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    {connection.avatarUrl ? (
                      <img src={connection.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
                    ) : null}
                    <div>
                      <div>{connection.accountName}</div>
                      <div className="text-xs text-muted-foreground">
                        {connection.status === "active" ? "已授权" : "授权已失效"} ·{" "}
                        {connection.authType}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-sm text-destructive"
                    onClick={() => {
                      if (!window.confirm(`解除 ${provider.label} 授权？`)) return;
                      void deleteGitConnection(connection.id)
                        .then(reload)
                        .catch((reason: unknown) => {
                          setError(String(reason));
                        });
                    }}
                  >
                    解除绑定
                  </button>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">未授权</div>
              )}
              {oauthConfigured[provider.id] ? (
                <button
                  type="button"
                  className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground"
                  onClick={() =>
                    void startGitOAuth(provider.id, returnTo).catch((reason) =>
                      setError(String(reason)),
                    )
                  }
                >
                  {connection ? "重新 OAuth 授权" : "OAuth 授权"}
                </button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  当前部署未配置 OAuth，可使用访问令牌。
                </p>
              )}
              <div className="space-y-2 border-t pt-3">
                <input
                  type="password"
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  placeholder="Personal Access Token"
                  value={tokens[provider.id] ?? ""}
                  onChange={(event) =>
                    setTokens((current) => ({ ...current, [provider.id]: event.target.value }))
                  }
                />
                <button
                  type="button"
                  className="w-full rounded border px-3 py-1.5 text-sm disabled:opacity-50"
                  disabled={busy === provider.id || !(tokens[provider.id] ?? "").trim()}
                  onClick={() => void savePat(provider.id)}
                >
                  {busy === provider.id ? "验证中…" : "使用令牌连接"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
