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
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : info ? (
          <>
            <div className="mb-2 text-lg font-medium">{info.name}</div>
            {info.description ? (
              <p className="mb-4 text-sm text-muted-foreground">{info.description}</p>
            ) : null}
            {getToken() ? (
              <p className="text-muted-foreground">正在进入…</p>
            ) : (
              <Link to="/login" className="rounded bg-primary px-4 py-2 text-primary-foreground">
                登录后进入该智能体
              </Link>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">加载中…</p>
        )}
      </div>
    </div>
  );
}
