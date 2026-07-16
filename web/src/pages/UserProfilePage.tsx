import { useEffect, useState } from "react";
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
  { provider: "dingtalk", label: "钉钉", available: true },
  { provider: "qq", label: "QQ", available: false },
  { provider: "feishu", label: "飞书", available: false },
  { provider: "wechat", label: "微信", available: false },
] as const;

export function UserProfilePage() {
  const [user, setUser] = useState<UserInfo>();
  const [identities, setIdentities] = useState<UserIdentity[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
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

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">基本信息</h1>
        <p className="mt-1 text-sm text-muted-foreground">当前登录用户的身份与登录渠道。</p>
      </div>
      {error ? <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

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
        <div className="grid gap-3 sm:grid-cols-2">
          {CHANNELS.map((channel) => {
            const identity = identities.find((item) => item.provider === channel.provider);
            const bound = Boolean(identity);
            return (
              <div
                key={channel.provider}
                className={`flex items-center justify-between rounded border px-3 py-2 ${
                  channel.available ? "" : "opacity-50"
                }`}
              >
                <div>
                  <div className="text-sm font-medium">{channel.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {bound
                      ? `已绑定${identity?.name ? `：${identity.name}` : ""}`
                      : channel.available
                        ? "未绑定"
                        : "待开发"}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">{bound ? "✓" : "—"}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
