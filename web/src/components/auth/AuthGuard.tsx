import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { getToken } from "../../lib/auth";

export function AuthGuard() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">加载中…</div>
    );
  }

  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
