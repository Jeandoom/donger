import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * 编辑器脏状态离开守卫（三个编辑器共用的 P1）：
 * - 浏览器刷新/关闭：beforeunload 原生确认
 * - 站内 <a> 链接点击：document 捕获阶段拦截（先于 react-router Link 的委托处理），
 *   # 锚点、外链、新标签、修饰键点击豁免
 * - 程序化跳转（返回/取消按钮）：用 attempt(action) 包装
 * 确认「丢弃并离开」后执行被拦截的跳转；「继续编辑」留在原地。
 * 返回的 dialog 需由调用方渲染进组件树。
 */
export function useDirtyGuard(dirty: boolean): {
  attempt: (action: () => void) => void;
  dialog: ReactNode;
} {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const anchor =
        e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || anchor.target === "_blank" || /^https?:/i.test(href)) {
        return;
      }
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      pendingRef.current = () => navigate(href);
      setConfirmOpen(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, navigate]);

  const attempt = useCallback((action: () => void) => {
    if (!dirtyRef.current) {
      action();
      return;
    }
    pendingRef.current = action;
    setConfirmOpen(true);
  }, []);

  const dialog = (
    <ConfirmDialog
      open={confirmOpen}
      title="有未保存的更改"
      description="离开将丢失未保存的修改。"
      confirmText="丢弃并离开"
      destructive
      onConfirm={() => {
        setConfirmOpen(false);
        const pending = pendingRef.current;
        pendingRef.current = null;
        pending?.();
      }}
      onCancel={() => {
        setConfirmOpen(false);
        pendingRef.current = null;
      }}
    />
  );

  return { attempt, dialog };
}
