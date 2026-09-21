import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { getToken } from "../../lib/auth";

/**
 * setup 状态模块级缓存（同 fetchMe 模式）：null=未探测。
 * setupRequired=true（零配置引导期）时所有受保护页面强制重定向 /setup，
 * 首个注册者完成初始化后缓存失效、正常放行。
 */
let setupRequiredCache: boolean | null = null;

export function invalidateSetupStatusCache(): void {
  setupRequiredCache = null;
}

export function AuthGuard() {
  const [state, setState] = useState<{ ready: boolean; setupRequired: boolean }>({
    ready: false,
    setupRequired: false,
  });

  useEffect(() => {
    let alive = true;
    const check = () => {
      if (setupRequiredCache !== null) {
        if (alive) setState({ ready: true, setupRequired: setupRequiredCache });
        return;
      }
      fetch("/api/setup/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { setupRequired?: boolean } | null) => {
          setupRequiredCache = !!data?.setupRequired;
          if (alive) setState({ ready: true, setupRequired: setupRequiredCache });
        })
        .catch(() => {
          // 探测失败按已初始化处理，不把用户锁在门外
          if (alive) setState({ ready: true, setupRequired: false });
        });
    };
    // 先同步落缓存值（有缓存时避免闪烁加载态）
    if (setupRequiredCache !== null) {
      setState({ ready: true, setupRequired: setupRequiredCache });
    } else {
      check();
    }
    return () => {
      alive = false;
    };
  }, []);

  if (!state.ready) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">加载中…</div>
    );
  }

  if (state.setupRequired) {
    return <Navigate to="/setup" replace />;
  }

  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
