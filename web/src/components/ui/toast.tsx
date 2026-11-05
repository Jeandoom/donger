import { CheckCircle2, Info, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";

/**
 * 全局 toast（chat UE 优化轮 E6-E）：成功/失败/信息三型 + 可选动作钮（如归档的「撤销」）。
 * 无动作 4s 自清，带动作 8s（给用户阅读时间）；右下角堆叠，不遮 composer。
 */

export type ToastKind = "success" | "error" | "info";

export interface ToastInput {
  kind: ToastKind;
  text: string;
  /** 可选动作（如「撤销」）；点击后 toast 立即关闭 */
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** 未挂 Provider 时的空实现（测试/孤立渲染树不炸） */
const noopApi: ToastApi = { push: () => {} };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(0);

  const push = useCallback((input: ToastInput) => {
    const id = ++nextIdRef.current;
    setItems((current) => [...current.slice(-3), { ...input, id }]);
    const ttl = input.actionLabel ? 8000 : 4000;
    setTimeout(() => {
      setItems((current) => current.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  const api = useMemo<ToastApi>(() => ({ push }), [push]);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-3 bottom-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2"
      >
        {items.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm shadow-lg",
              toast.kind === "success" && "border-success/30 bg-success-soft text-success",
              toast.kind === "error" &&
                "border-destructive/30 bg-destructive-soft text-destructive",
              toast.kind === "info" && "border-border bg-card text-foreground",
            )}
          >
            {toast.kind === "success" ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : toast.kind === "error" ? (
              <XCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <Info
                size={15}
                className="mt-0.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 break-words text-foreground">{toast.text}</span>
            {toast.actionLabel ? (
              <button
                type="button"
                onClick={() => {
                  toast.onAction?.();
                  dismiss(toast.id);
                }}
                className="shrink-0 text-xs font-semibold text-primary underline underline-offset-2"
              >
                {toast.actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  const api = ctx ?? noopApi;
  return useMemo(
    () => ({
      success: (text: string) => api.push({ kind: "success", text }),
      error: (text: string) => api.push({ kind: "error", text }),
      info: (text: string, actionLabel?: string, onAction?: () => void) =>
        api.push({ kind: "info", text, ...(actionLabel ? { actionLabel, onAction } : {}) }),
    }),
    [api],
  );
}
