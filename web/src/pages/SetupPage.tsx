import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { invalidateSetupStatusCache } from "../components/auth/AuthGuard";
import { Button } from "../components/ui/button";
import { setLoginNext, setToken } from "../lib/auth";

/**
 * 零配置引导：初始化管理员（spec 2026-09-21-auth-module-design §3.4）。
 * 服务端 setupRequired=true 时所有入口强制重定向到此页；首个注册者成为 admin，
 * 邮箱直接置已验证（首用户场景不存在可转交验证链接的管理员）。
 *
 * 创建成功后显示「执行引擎就绪」确认（specs/2026-10-11-plugin-system-design.md §4）：
 * Claude 引擎默认安装并启用（默认引擎）；Codex 内置即用；ZCode 可在插件页安装钉版。
 * 不阻塞流程——确认页仅呈现默认态与入口，引擎裁剪/安装随时可在插件页进行。
 */
export function SetupPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "required" | "done" | "created">("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLoginNext("/");
    fetch("/api/setup/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { setupRequired?: boolean } | null) =>
        setStatus(data?.setupRequired ? "required" : "done"),
      )
      .catch(() => setStatus("done"));
  }, []);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    fetch("/api/setup/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
      }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
        if (!r.ok || !data.token) {
          throw new Error(data.error ?? `初始化失败（HTTP ${r.status}）`);
        }
        return data;
      })
      .then((data) => {
        setToken(data.token ?? "");
        // 失效 setup 缓存：否则 AuthGuard 仍按引导期拦截刚创建的 admin
        invalidateSetupStatusCache();
        // 引擎就绪确认（不阻塞）：展示默认引擎与插件页入口，随时可进授权模块
        setStatus("created");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sidebar text-sm text-muted-foreground">
        正在检查初始化状态…
      </div>
    );
  }
  if (status === "done") {
    return <Navigate to="/login" replace />;
  }

  if (status === "created") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sidebar px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2">
            <img src="/pwa-icon.svg" alt="donger logo" className="h-8 w-8 rounded-lg" />
            <span className="text-lg font-bold text-white">donger</span>
          </div>
          <div className="rounded-2xl border border-border bg-background p-6 shadow-xl">
            <h2 className="text-[20px] font-bold">初始化完成</h2>
            <p className="mt-1 mb-4 text-[12px] text-muted-foreground">
              管理员已创建，执行引擎已就绪：
            </p>
            <ul className="mb-5 space-y-1.5 text-[13px]">
              <li className="flex items-center gap-2">
                <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">
                  默认
                </span>
                Claude 引擎 — 已安装并启用（anthropic 协议平台）
              </li>
              <li className="flex items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  内置
                </span>
                Codex 引擎 — 即装即用（openai 协议平台）
              </li>
              <li className="flex items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  可选
                </span>
                ZCode 引擎 — 可随时在插件页安装运行时并钉版
              </li>
            </ul>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => navigate("/authorization", { replace: true })}
              >
                配置登录与授权 →
              </Button>
              <Button variant="secondary" onClick={() => navigate("/plugins", { replace: true })}>
                打开插件页
              </Button>
            </div>
            <p className="mt-4 text-center text-[12px] text-muted-foreground">
              引擎启停与运行时安装随时可在「插件」页进行
              <span className="mx-1">·</span>
              <Link to="/" className="underline">
                直接进入系统
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <img src="/pwa-icon.svg" alt="donger logo" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-bold text-white">donger</span>
        </div>
        <div className="rounded-2xl border border-border bg-background p-6 shadow-xl">
          <h2 className="text-[20px] font-bold">初始化管理员</h2>
          <p className="mt-1 mb-5 text-[12px] text-muted-foreground">
            系统尚无管理员账号。第一个注册的账号将成为管理员，请使用邮箱设置登录凭据
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
              placeholder="管理员邮箱"
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
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              placeholder="初始化 Token（仅服务端配置了 SETUP_TOKEN 时需要）"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "初始化中…" : "创建管理员并进入系统"}
            </Button>
          </form>

          <p className="mt-4 text-center text-[12px] text-muted-foreground">
            初始化完成后可在「授权」模块配置钉钉/GitHub 登录
            <span className="mx-1">·</span>
            <Link to="/login" className="underline">
              返回登录
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
