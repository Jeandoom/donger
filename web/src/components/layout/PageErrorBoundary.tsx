import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Link } from "react-router-dom";

/** 页面级渲染崩溃兜底：包住 Outlet，页面异常不再整树卸载白屏（如 /skills 事故）。 */
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <div className="text-lg font-semibold text-foreground">页面出错了</div>
          <p className="max-w-md break-all text-center">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 hover:bg-accent"
              onClick={resetErrorBoundary}
            >
              重试
            </button>
            <Link to="/" className="rounded-md border px-3 py-1.5 hover:bg-accent">
              返回会话
            </Link>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
