import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { apiFetch, getToken, setLoginNext, setToken } from "../lib/auth";

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 邮箱登录
  const [showEmailLogin, setShowEmailLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  // 登录成功后的回跳目标（分享链接等场景经 ?next= 传入；默认回首页）
  const next = searchParams.get("next") || "/";

  // 缓存到 localStorage，供 LoginSuccessPage「无 opener 直开」场景读取
  useEffect(() => {
    setLoginNext(next);
  }, [next]);

  // 监听弹窗 postMessage
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === "login-success" && typeof ev.data.token === "string") {
        setToken(ev.data.token);
        navigate(next, { replace: true });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [navigate, next]);

  // 处理错误
  useEffect(() => {
    const err = searchParams.get("error");
    if (err) {
      setError(decodeURIComponent(err));
    }
  }, [searchParams]);

  // 已登录用户访问登录页直接回跳目标页（replace 避免历史残留登录页）
  useEffect(() => {
    if (getToken()) navigate(next, { replace: true });
  }, [navigate, next]);

  const loadQr = useCallback(() => {
    setLoading(true);
    setError(null);
    // GitHub 登录探测：未配置（503）时隐藏对应按钮，不影响钉钉主流程
    fetch("/api/auth/github/url")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { url?: string } | null) => setGithubUrl(data?.url ?? null))
      .catch(() => setGithubUrl(null));
    fetch("/api/auth/qrcode-url")
      .then((r) => r.json())
      .then((data) => {
        if (data.url) setQrUrl(data.url);
        else setError("无法获取登录二维码");
      })
      .catch(() => setError("无法连接到服务器"))
      .finally(() => setLoading(false));
  }, []);

  // 获取钉钉扫码 URL
  useEffect(() => {
    loadQr();
  }, [loadQr]);

  const openQr = () => {
    if (!qrUrl) return;
    const w = window.open(qrUrl, "dingtalk-login", "width=500,height=600");
    if (!w) setError("弹窗被拦截，请允许弹出窗口或手动复制链接到浏览器打开");
  };

  const openGithub = () => {
    if (!githubUrl) return;
    const w = window.open(githubUrl, "github-login", "width=600,height=700");
    if (!w) setError("弹窗被拦截，请允许弹出窗口或手动复制链接到浏览器打开");
  };

  const submitEmailLogin = (ev: React.FormEvent) => {
    ev.preventDefault();
    setAuthError(null);
    setAuthBusy(true);
    void apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `登录失败（HTTP ${r.status}）`);
        }
        return (await r.json()) as { token: string };
      })
      .then((data) => {
        setToken(data.token);
        navigate(next, { replace: true });
      })
      .catch((reason: unknown) =>
        setAuthError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setAuthBusy(false));
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar">
        <div className="text-center">
          <img src="/pwa-icon.svg" alt="donger logo" className="mx-auto mb-4 h-12 w-12" />
          <div className="text-sm text-sidebar-foreground">正在准备登录…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-sidebar">
      {/* 左：品牌区 */}
      <div className="hidden flex-1 flex-col justify-center gap-6 px-16 lg:flex">
        <div className="flex items-center gap-3">
          <img src="/pwa-icon.svg" alt="donger logo" className="h-10 w-10 rounded-xl" />
          <span className="text-2xl font-bold text-white">donger</span>
        </div>
        <h1 className="max-w-md text-[34px] font-bold leading-snug text-white">
          技能驱动的通用自动化
          <br />
          Agent 服务
        </h1>
        <p className="max-w-md text-sm text-[#94A3B8]">
          可插拔 LLM · 钉钉 / Web 远程管理 · 高危操作 IM 审批门
        </p>
        <div className="flex flex-wrap gap-4">
          {["10+ 技能包", "5 类自动化", "IM 审批门"].map((t) => (
            <span key={t} className="rounded-lg bg-[#1E293B] px-3.5 py-2 text-xs text-[#CBD5E1]">
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* 右：登录卡 */}
      <div className="flex flex-1 items-center justify-center bg-background px-6 py-12 lg:flex-none lg:w-[560px]">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <img src="/pwa-icon.svg" alt="donger logo" className="h-8 w-8 rounded-lg" />
            <span className="text-lg font-bold">donger</span>
          </div>
          <h2 className="text-[22px] font-bold">登录</h2>
          <p className="mt-1 mb-6 text-[13px] text-muted-foreground">
            钉钉扫码 / GitHub / 邮箱登录
          </p>

          {error ? (
            <div className="mb-4 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
              {error}
              <button type="button" className="ml-2 underline" onClick={loadQr}>
                重试
              </button>
            </div>
          ) : null}

          {!error && (
            <div className="space-y-4">
              <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-muted">
                <div className="flex h-24 w-24 items-center justify-center rounded-lg border border-border bg-card text-4xl text-muted-foreground/50">
                  口
                </div>
                <span className="text-xs text-muted-foreground">打开钉钉「扫一扫」</span>
              </div>
              <Button className="w-full" onClick={openQr} disabled={!qrUrl}>
                钉钉扫码登录
              </Button>
              {githubUrl ? (
                <Button variant="outline" className="w-full" onClick={openGithub}>
                  使用 GitHub 登录
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={() => setShowEmailLogin((v) => !v)}
              >
                {showEmailLogin ? "收起邮箱登录" : "邮箱账号登录"}
              </Button>
              {showEmailLogin ? (
                <form
                  className="space-y-3 rounded-xl border border-border bg-muted/40 p-4"
                  onSubmit={submitEmailLogin}
                >
                  {authError ? (
                    <div className="rounded bg-destructive-soft p-2 text-xs text-destructive">
                      {authError}
                    </div>
                  ) : null}
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
                    placeholder="密码"
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                  <Button type="submit" className="w-full" disabled={authBusy}>
                    {authBusy ? "登录中…" : "登录"}
                  </Button>
                  <p className="text-center text-[11px] text-muted-foreground/80">
                    没有账号？
                    <Link
                      to={`/register${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}
                      className="ml-1 underline"
                    >
                      注册新账号
                    </Link>
                  </p>
                </form>
              ) : null}
              <p className="text-center text-[11px] text-muted-foreground/80">
                首次扫码/GitHub 登录将自动创建账号并绑定对应平台身份
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
