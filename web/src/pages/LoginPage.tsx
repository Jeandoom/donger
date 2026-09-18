import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { apiFetch, getToken, setLoginNext, setToken } from "../lib/auth";
import { type LoginMethodKey, parseLoginMethods } from "../lib/loginMethods";

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 可用登录方式（null=探测中；[] = 服务端未配置任何方式），按 邮箱>钉钉>GitHub 优先级排序
  const [methods, setMethods] = useState<LoginMethodKey[] | null>(null);
  // 各 OAuth 方式的授权 URL（点击时须同步 window.open，预取避免弹窗拦截）
  const [dingtalkUrl, setDingtalkUrl] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  // 邮箱登录（首选方式）
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

  // 监听弹窗 postMessage（钉钉/GitHub 授权弹窗回传）
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

  // OAuth 回调失败经 ?error= 回登录页展示
  useEffect(() => {
    const err = searchParams.get("error");
    if (err) {
      setAuthError(decodeURIComponent(err));
    }
  }, [searchParams]);

  // 已登录用户访问登录页直接回跳目标页（replace 避免历史残留登录页）
  useEffect(() => {
    if (getToken()) navigate(next, { replace: true });
  }, [navigate, next]);

  // 登录方式动态探测：按 .env 实际配置渲染（钉钉/GitHub App、邮箱开关）；探测失败回退邮箱保底
  useEffect(() => {
    fetch("/api/auth/methods")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { methods?: unknown } | null) => setMethods(parseLoginMethods(data?.methods)))
      .catch(() => setMethods(parseLoginMethods(null)));
  }, []);

  // 已启用方式预取授权 URL（未配置/失败 → 置 null 隐藏按钮）
  useEffect(() => {
    if (!methods?.includes("dingtalk")) return;
    fetch("/api/auth/qrcode-url")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { url?: string } | null) => setDingtalkUrl(data?.url ?? null))
      .catch(() => setDingtalkUrl(null));
  }, [methods]);

  useEffect(() => {
    if (!methods?.includes("github")) return;
    fetch("/api/auth/github/url")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { url?: string } | null) => setGithubUrl(data?.url ?? null))
      .catch(() => setGithubUrl(null));
  }, [methods]);

  const openOauthPopup = (url: string | null, windowName: string) => {
    if (!url) return;
    const w = window.open(url, windowName, "width=600,height=700");
    if (!w) setAuthError("弹窗被拦截，请允许弹出窗口或手动复制链接到浏览器打开");
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

  const hasEmail = !!methods?.includes("email");
  const hasDingtalk = !!methods?.includes("dingtalk");
  const hasGithub = !!methods?.includes("github");
  const hasAlternates = hasDingtalk || hasGithub;
  const subtitle = !methods
    ? "正在加载登录方式…"
    : methods.length === 0
      ? "本实例未配置任何登录方式，请联系管理员"
      : `使用${[hasEmail && "邮箱", hasDingtalk && "钉钉扫码", hasGithub && "GitHub"]
          .filter(Boolean)
          .join(" / ")}登录`;

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
          <p className="mt-1 mb-6 text-[13px] text-muted-foreground">{subtitle}</p>

          {authError ? (
            <div className="mb-4 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
              {authError}
            </div>
          ) : null}

          {methods === null ? (
            // 探测中：骨架占位，避免方式集变化时闪跳
            <div className="space-y-3" aria-hidden>
              <div className="h-9 animate-pulse rounded-lg bg-muted" />
              <div className="h-9 animate-pulse rounded-lg bg-muted" />
              <div className="h-9 animate-pulse rounded-lg bg-muted" />
            </div>
          ) : (
            <>
              {/* 优先级 1：邮箱表单 */}
              {hasEmail ? (
                <form className="space-y-3" onSubmit={submitEmailLogin}>
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
                  <p className="text-center text-[12px] text-muted-foreground">
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

              {/* 优先级 2/3：钉钉扫码、GitHub */}
              {hasEmail && hasAlternates ? (
                <div className="my-5 flex items-center gap-3 text-[11px] text-muted-foreground/70">
                  <span className="h-px flex-1 bg-border" />
                  其他登录方式
                  <span className="h-px flex-1 bg-border" />
                </div>
              ) : null}

              {hasAlternates ? (
                <div className="space-y-3">
                  {hasDingtalk && dingtalkUrl ? (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => openOauthPopup(dingtalkUrl, "dingtalk-login")}
                    >
                      使用钉钉扫码登录
                    </Button>
                  ) : null}
                  {hasGithub && githubUrl ? (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => openOauthPopup(githubUrl, "github-login")}
                    >
                      使用 GitHub 登录
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {methods.length === 0 ? (
                <p className="rounded-lg bg-muted p-3 text-center text-[13px] text-muted-foreground">
                  未启用任何登录方式：请在服务端 .env 配置钉钉/GitHub 应用或开启邮箱登录后重启
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
