import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, setToken } from "../lib/auth";

interface MergeState {
  token: string;
  userId: string;
  name: string;
  avatar: string;
}

export function MergePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get("token");
    const userId = searchParams.get("userId");
    const name = searchParams.get("name");
    const avatar = searchParams.get("avatar");

    if (token && userId) {
      setMergeState({ token, userId, name: name ?? "未知用户", avatar: avatar ?? "" });
      // 临时存 JWT（用于后续 merge-confirm 请求）
      setToken(token);
    } else {
      setError("登录信息不完整，请重新扫码");
    }
  }, [searchParams]);

  const handleMerge = useCallback(async () => {
    if (!mergeState) return;
    setConfirming(true);
    try {
      const res = await apiFetch("/api/auth/merge-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUserId: mergeState.userId }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        setError(err.error ?? "合并失败");
        return;
      }
      const data = (await res.json()) as { token: string; user: { id: string; name?: string } };
      if (window.opener) {
        window.opener.postMessage({ type: "login-success", token: data.token }, "*");
        setTimeout(() => window.close(), 500);
      } else {
        setToken(data.token);
        navigate("/", { replace: true });
      }
    } catch {
      setError("合并请求失败，请重试");
    } finally {
      setConfirming(false);
    }
  }, [mergeState, navigate]);

  const handleNewUser = useCallback(() => {
    if (!mergeState) return;
    if (window.opener) {
      window.opener.postMessage({ type: "login-success", token: mergeState.token }, "*");
      setTimeout(() => window.close(), 500);
    } else {
      navigate("/", { replace: true });
    }
  }, [mergeState, navigate]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-destructive">❌ {error}</div>
        <button
          className="text-sm text-primary underline"
          onClick={() => navigate("/login")}
        >
          重新登录
        </button>
      </div>
    );
  }

  if (!mergeState) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        加载中…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-muted/50">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 text-center shadow-sm">
        <div className="mb-4 text-5xl">🔗</div>
        <h1 className="mb-2 text-xl font-semibold">检测到已有账户</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          该钉钉账号已在系统中存在，是否将当前登录合并到已有账户？
        </p>

        {/* 用户信息展示 */}
        <div className="mb-6 flex items-center justify-center gap-3 rounded-md bg-muted/50 p-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-lg font-bold text-primary">
            {mergeState.avatar ? (
              <img src={mergeState.avatar} alt="" className="h-12 w-12 rounded-full" />
            ) : (
              mergeState.name.charAt(0)
            )}
          </div>
          <div className="text-left">
            <div className="font-medium">{mergeState.name}</div>
            <div className="text-xs text-muted-foreground">已有账户</div>
          </div>
        </div>

        <div className="space-y-3">
          <button
            className="w-full rounded-lg bg-primary px-4 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            onClick={handleMerge}
            disabled={confirming}
          >
            {confirming ? "合并中…" : "✅ 确认合并 — 合并所有数据"}
          </button>

          <button
            className="w-full rounded-lg border px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
            onClick={handleNewUser}
            disabled={confirming}
          >
            不合并，以新用户身份使用
          </button>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          合并后，原有会话、记忆、工作区文件将归入同一账号
        </p>
      </div>
    </div>
  );
}