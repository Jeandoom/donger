import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { apiFetch } from "../lib/auth";

interface UserInfo {
  id: string;
  name: string;
  avatar?: string;
  role: string;
  createdAt: string;
}

interface UserIdentity {
  id: string;
  provider: string;
  externalId: string;
  name?: string;
  avatar?: string;
}

const CHANNELS = [
  { provider: "dingtalk", label: "钉钉" },
  { provider: "github", label: "GitHub" },
  { provider: "qq", label: "QQ" },
  { provider: "feishu", label: "飞书" },
  { provider: "wechat", label: "微信" },
] as const;

export function UserProfilePage() {
  const [user, setUser] = useState<UserInfo>();
  const [identities, setIdentities] = useState<UserIdentity[]>([]);
  const [error, setError] = useState("");
  const [bindError, setBindError] = useState("");
  // 后端已配置 GitHub OAuth（/api/auth/github/url 200=已配置，503=未配置）
  const [githubConfigured, setGithubConfigured] = useState(false);

  const loadProfile = useCallback(() => {
    void apiFetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) throw new Error(`加载用户信息失败：HTTP ${response.status}`);
        return (await response.json()) as { user: UserInfo; identities: UserIdentity[] };
      })
      .then((data) => {
        setUser(data.user);
        setIdentities(data.identities);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  useEffect(() => {
    loadProfile();
    void fetch("/api/auth/github/url")
      .then((r) => setGithubConfigured(r.ok))
      .catch(() => setGithubConfigured(false));
  }, [loadProfile]);

  // 绑定弹窗回传：刷新身份列表
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === "bind-success" && ev.data.provider === "github") {
        loadProfile();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [loadProfile]);

  const startGithubBind = () => {
    setBindError("");
    void apiFetch("/api/auth/github/bind")
      .then(async (r) => {
        if (!r.ok) throw new Error(`发起绑定失败：HTTP ${r.status}`);
        return (await r.json()) as { url?: string };
      })
      .then((data) => {
        if (!data.url) throw new Error("未获取到授权地址");
        const w = window.open(data.url, "github-bind", "width=600,height=700");
        if (!w) setBindError("弹窗被拦截，请允许弹出窗口后重试");
      })
      .catch((reason: unknown) =>
        setBindError(reason instanceof Error ? reason.message : String(reason)),
      );
  };

  const channelAvailable = (provider: string): boolean =>
    provider === "github" ? githubConfigured : provider === "dingtalk";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <PageHeader title="个人设置" description="当前登录用户的身份与登录渠道" />
      {error ? (
        <div className="rounded bg-destructive-soft p-3 text-sm text-destructive">{error}</div>
      ) : null}

      {user ? (
        <section className="flex items-center gap-4 rounded-lg border bg-background p-5">
          {user.avatar ? (
            <img src={user.avatar} alt={`${user.name}头像`} className="h-16 w-16 rounded-full" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-2xl font-semibold text-primary">
              {user.name.charAt(0)}
            </div>
          )}
          <div>
            <div className="text-lg font-semibold">{user.name}</div>
            <div className="mt-1 text-xs text-muted-foreground">用户 ID：{user.id}</div>
          </div>
        </section>
      ) : null}

      <section className="space-y-3 rounded-lg border bg-background p-5">
        <h2 className="font-medium">已绑定的登录渠道</h2>
        {bindError ? (
          <div className="rounded bg-destructive-soft p-2 text-sm text-destructive">
            {bindError}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {CHANNELS.map((channel) => {
            const identity = identities.find((item) => item.provider === channel.provider);
            const bound = Boolean(identity);
            const available = channelAvailable(channel.provider);
            return (
              <div
                key={channel.provider}
                className={`flex items-center justify-between rounded border px-3 py-2 ${
                  available ? "" : "opacity-50"
                }`}
              >
                <div>
                  <div className="text-sm font-medium">{channel.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {bound
                      ? `已绑定${identity?.name ? `：${identity.name}` : ""}`
                      : available
                        ? "未绑定"
                        : "待开发"}
                  </div>
                </div>
                {bound ? (
                  <span className="text-xs text-muted-foreground">✓</span>
                ) : channel.provider === "github" && available ? (
                  <Button variant="outline" size="sm" onClick={startGithubBind}>
                    绑定
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
