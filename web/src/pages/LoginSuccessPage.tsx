import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { setToken, takeLoginNext } from "../lib/auth";

/** 一次性 code 换 JWT（规格 M4：token 不再经 URL 传递） */
async function exchangeCode(code: string): Promise<string> {
  const res = await fetch("/api/auth/code-exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error("exchange failed");
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("no token");
  return body.token;
}

export function LoginSuccessPage() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<"sending" | "done" | "error">("sending");

  useEffect(() => {
    const mode = searchParams.get("mode");
    const provider = searchParams.get("provider") ?? "github";
    // 新形态：一次性 code（60 秒单次有效）；旧 ?token= 形态保留一版兼容缓存的旧落地页
    const code = searchParams.get("code");
    const legacyToken = searchParams.get("token");

    async function settle(token: string): Promise<void> {
      // 身份绑定回调：通知主页面刷新绑定列表（不落 token，主窗口会话保持不变）
      if (mode === "bind") {
        if (window.opener) {
          // targetOrigin 必须限定本站源：'*' 会把消息（含 token 形态）送进任意 opener，
          // 弹窗链被钓鱼页面持有即整段 JWT 外泄
          window.opener.postMessage({ type: "bind-success", provider }, window.location.origin);
          setStatus("done");
          setTimeout(() => window.close(), 500);
        } else {
          setStatus("done");
        }
        return;
      }

      // 存入 localStorage（弹窗自己的）
      setToken(token);

      // 通知主页面
      if (window.opener) {
        window.opener.postMessage({ type: "login-success", token }, window.location.origin);
        setStatus("done");
        // 短暂延迟后关闭弹窗，给主页面处理时间
        setTimeout(() => window.close(), 500);
      } else {
        // 不是在弹窗中打开（用户直接浏览器打开），跳到登录前记下的 next（默认首页）
        const next = takeLoginNext() ?? "/";
        window.location.href = next;
      }
    }

    if (code) {
      exchangeCode(code)
        .then(settle)
        .catch(() => setStatus("error"));
      return;
    }

    if (legacyToken) {
      void settle(legacyToken);
      return;
    }

    // 无 code 且无 token：bind 模式的旧弹窗直接成功收尾，其余视为信息不完整
    if (mode === "bind") {
      setStatus("done");
      return;
    }
    setStatus("error");
  }, [searchParams]);

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-6">
      <div className="w-full max-w-xs rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        {status === "error" ? (
          <>
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive-soft text-2xl text-destructive">
              ✕
            </div>
            <p className="text-sm text-destructive">登录信息不完整或已过期，请关闭此窗口重新登录</p>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-2xl font-bold text-success">
              ✓
            </div>
            <p className="text-[15px] font-semibold">登录成功</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {status === "done" ? "窗口即将关闭…" : "正在处理…"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
