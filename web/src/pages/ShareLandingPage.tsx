import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getToken } from "../lib/auth";
import { acceptShare, fetchPublicShare, type PublicShareInfo } from "../lib/share";

export function ShareLandingPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<PublicShareInfo>();
  const [error, setError] = useState<string>();

  // 1. 校验分享链接（公开）
  useEffect(() => {
    fetchPublicShare(token)
      .then(setInfo)
      .catch(() => setError("分享链接无效或已失效"));
  }, [token]);

  // 2. 已登录 → accept + 跳对话；未登录 → 提示登录，监听 token 出现后自动继续
  useEffect(() => {
    if (!info) return;
    if (getToken()) {
      acceptShare(info.agentId, token)
        .then((r) => navigate(`/agents/${r.conversation.agentId}/chat`, { replace: true }))
        .catch((e) => setError(String(e)));
      return;
    }
    // 未登录：监听其它标签页/弹窗写入 token 后自动重试
    const onStorage = (e: StorageEvent) => {
      if (e.key === "donger_jwt" && getToken()) {
        acceptShare(info.agentId, token)
          .then((r) => navigate(`/agents/${r.conversation.agentId}/chat`, { replace: true }))
          .catch((e2) => setError(String(e2)));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [info, token, navigate]);

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-xl">
        <div className="mb-5 flex items-center gap-2.5">
          <img src="/pwa-icon.svg" alt="donger logo" className="h-8 w-8 rounded-lg" />
          <span className="text-base font-bold">donger</span>
        </div>
        {error ? (
          <>
            <h1 className="text-lg font-bold">分享链接无效</h1>
            <p className="mt-1.5 text-sm text-destructive">{error}</p>
            <Link
              to="/login"
              className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              去登录
            </Link>
          </>
        ) : info ? (
          <>
            <h1 className="text-lg font-bold">「{info.name}」被分享给你</h1>
            {info.description ? (
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{info.description}</p>
            ) : null}
            {getToken() ? (
              <p className="mt-6 text-sm text-muted-foreground">正在进入…</p>
            ) : (
              <Link
                to={`/login?next=/share/${token}`}
                className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                登录后进入该智能体
              </Link>
            )}
            <p className="mt-4 text-[11px] text-muted-foreground/80">
              登录将自动完成分享授权，你只会看到分享给你的智能体。
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">加载中…</p>
        )}
      </div>
    </div>
  );
}
