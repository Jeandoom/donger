import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getToken, setLoginNext, setToken } from "../lib/auth";

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 登录成功后的回跳目标（分享链接等场景经 ?next= 传入；默认回首页）
  const next = searchParams.get("next") || "/";

  // 缓存到 localStorage，供 LoginSuccessPage「无 opener 直开」场景读取
  useEffect(() => {
    setLoginNext(next);
  }, [next]);

  // @新增：监听弹窗 postMessage
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

  // 获取钉钉扫码 URL
  useEffect(() => {
    fetch("/api/auth/qrcode-url")
      .then((r) => r.json())
      .then((data) => {
        if (data.url) {
          setQrUrl(data.url);
        } else {
          setError("无法获取登录二维码");
        }
      })
      .catch(() => setError("无法连接到服务器"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="mb-4 text-4xl">📱</div>
          <div className="text-muted-foreground">正在准备登录…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-muted/50">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 text-center shadow-sm">
        <div className="mb-6 text-5xl">🤖</div>
        <h1 className="mb-2 text-xl font-semibold">donger</h1>
        <p className="mb-6 text-sm text-muted-foreground">使用钉钉扫码登录</p>

        {error && (
          <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                setError(null);
                setLoading(true);
                fetch("/api/auth/qrcode-url")
                  .then((r) => r.json())
                  .then((data) => {
                    if (data.url) setQrUrl(data.url);
                    else setError("无法获取登录二维码");
                  })
                  .catch(() => setError("无法连接到服务器"))
                  .finally(() => setLoading(false));
              }}
            >
              重试
            </button>
          </div>
        )}

        {qrUrl && !error && (
          <div className="space-y-4">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg bg-[#1677FF] px-6 py-3 text-white shadow-lg transition-colors hover:bg-[#1677FF]/90"
              onClick={() => {
                const w = window.open(qrUrl, "dingtalk-login", "width=500,height=600");
                if (!w) {
                  setError("弹窗被拦截，请允许弹出窗口或手动复制链接到浏览器打开");
                }
              }}
            >
              <span className="text-xl">🔵</span>
              <span className="font-medium">钉钉扫码登录</span>
            </button>

            <p className="text-xs text-muted-foreground">点击按钮后，使用钉钉扫描二维码完成登录</p>

            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              扫码后请耐心等待，页面会自动跳转…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
