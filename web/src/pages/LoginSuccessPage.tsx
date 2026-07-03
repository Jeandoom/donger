import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { setToken } from "../lib/auth";

export function LoginSuccessPage() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<"sending" | "done" | "error">("sending");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      return;
    }

    // 存入 localStorage（弹窗自己的）
    setToken(token);

    // 通知主页面
    if (window.opener) {
      window.opener.postMessage(
        { type: "login-success", token },
        window.location.origin,
      );
      setStatus("done");
      // 短暂延迟后关闭弹窗，给主页面处理时间
      setTimeout(() => window.close(), 500);
    } else {
      // 不是在弹窗中打开（用户直接浏览器打开），做页面跳转
      window.location.href = "/";
    }
  }, [searchParams]);

  if (status === "error") {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-destructive">
        登录信息不完整，请关闭此窗口重新登录
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <div className="mb-4 text-4xl">✅</div>
        <div className="text-sm text-muted-foreground">
          {status === "done" ? "登录成功，窗口即将关闭…" : "正在处理…"}
        </div>
      </div>
    </div>
  );
}
