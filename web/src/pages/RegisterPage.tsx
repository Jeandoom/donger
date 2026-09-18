import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { apiFetch, getToken, setLoginNext, setToken } from "../lib/auth";

/** 邮箱注册页。持邀请链接（?invite=）注册不受邮箱域名白名单限制。 */
export function RegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") || "/";
  const inviteFromUrl = searchParams.get("invite")?.trim() ?? "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [invite, setInvite] = useState(inviteFromUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLoginNext(next);
    if (getToken()) navigate(next, { replace: true });
  }, [navigate, next]);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    void apiFetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, invite: invite || undefined }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `注册失败（HTTP ${r.status}）`);
        }
        return (await r.json()) as { token: string };
      })
      .then((data) => {
        setToken(data.token);
        navigate(next, { replace: true });
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <img src="/pwa-icon.svg" alt="donger logo" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-bold text-white">donger</span>
        </div>
        <div className="rounded-2xl border border-border bg-background p-6 shadow-xl">
          <h2 className="text-[20px] font-bold">注册新账号</h2>
          <p className="mt-1 mb-5 text-[12px] text-muted-foreground">
            {invite ? "已识别邀请链接，可使用任意邮箱注册" : "使用邮箱注册；非白名单域名需邀请链接"}
          </p>

          {error ? (
            <div className="mb-4 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <form className="space-y-3" onSubmit={submit}>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="邮箱"
              autoComplete="email"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码（至少 8 位，含字母和数字）"
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="确认密码"
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              type="text"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              placeholder="邀请码（可选）"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "注册中…" : "注册并登录"}
            </Button>
          </form>

          <p className="mt-4 text-center text-[12px] text-muted-foreground">
            已有账号？
            <Link
              to={`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}
              className="ml-1 underline"
            >
              返回登录
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
