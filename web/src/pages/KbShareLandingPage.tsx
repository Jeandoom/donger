import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getToken } from "../lib/auth";
import { acceptKbShare, fetchKbByShare } from "../lib/kb";

/** /kb-share/:token 知识库分享落地页（公开；登录后自动接受授权进入库详情） */
export function KbShareLandingPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ kbId: string; name: string; description: string }>();
  const [error, setError] = useState<string>();

  // 1. 校验分享链接（公开，只回名称/描述）
  useEffect(() => {
    fetchKbByShare(token)
      .then(setInfo)
      .catch(() => setError("分享链接无效或已失效"));
  }, [token]);

  // 2. 已登录 → accept + 跳库详情；未登录 → 提示登录，监听其它标签页写入 token 后自动继续
  useEffect(() => {
    if (!info) return;
    if (getToken()) {
      acceptKbShare(info.kbId, token)
        .then(() => navigate(`/kb/${info.kbId}`, { replace: true }))
        .catch((e) => setError(String(e)));
      return;
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === "donger_jwt" && getToken()) {
        acceptKbShare(info.kbId, token)
          .then(() => navigate(`/kb/${info.kbId}`, { replace: true }))
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
            <h1 className="text-lg font-bold">知识库「{info.name}」被分享给你</h1>
            {info.description ? (
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{info.description}</p>
            ) : null}
            {getToken() ? (
              <p className="mt-6 text-sm text-muted-foreground">正在进入…</p>
            ) : (
              <Link
                to={`/login?next=/kb-share/${token}`}
                className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                登录后进入该知识库
              </Link>
            )}
            <p className="mt-4 text-[11px] text-muted-foreground/80">
              登录将自动完成分享授权，你将以只读方式访问该知识库。
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">加载中…</p>
        )}
      </div>
    </div>
  );
}
