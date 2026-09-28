import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * 编辑器脏状态离开守卫（三个编辑器共用的 P1）：
 * - 浏览器刷新/关闭：beforeunload 原生确认
 * - 站内 <a> 链接点击：document 捕获阶段拦截（先于 react-router Link 的委托处理），
 *   # 锚点、外链、新标签、修饰键点击豁免
 * - 程序化跳转（返回/取消按钮）：用 attempt(action) 包装
 * - 浏览器返回手势/返回键（移动端边缘滑动即此）：哨兵 history 帧拦截
 * 确认「丢弃并离开」后执行被拦截的跳转；「继续编辑」留在原地。
 * 返回的 dialog 需由调用方渲染进组件树。
 */

/** 哨兵帧标记：dirty 期间压入的 history 条目 state 带此键，返回手势先撞它而非真离开 */
const GUARD_FLAG = "dongerDirtyGuard";

function hasGuardFlag(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && GUARD_FLAG in (state as object));
}

export function useDirtyGuard(dirty: boolean): {
  attempt: (action: () => void) => void;
  dialog: ReactNode;
} {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** popstate 来的确认在处理中：丢弃时下一次 popstate 是自己触发的 history.back，不再弹窗 */
  const ignoreNextPopRef = useRef(false);
  /** 当前确认弹窗是否由返回手势（popstate）触发：决定确认/取消后的哨兵帧处置 */
  const popOriginRef = useRef(false);
  /** 哨兵帧是否由本实例压入：区分「可退帧消费」与「刷新残留标记」（残留只能原地抹除，不能 back） */
  const pushedRef = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // 哨兵帧：dirty 期间压入一帧（URL 不变）；返回手势先弹出哨兵帧（页面无变化）
  // 触发 popstate，此时弹确认——继续编辑则把哨兵帧压回去，丢弃则再退一帧真离开。
  // 刷新会保留栈顶 state 的标记：必须先 replaceState 抹掉再压新帧，
  // 否则一次返回会直接跨过守卫落到上一页（标记页被 reload 复用所致）。
  useEffect(() => {
    if (!dirty) {
      if (hasGuardFlag(window.history.state)) {
        if (pushedRef.current) {
          // 本实例压的帧：退一帧消费掉，不给用户留「按一次返回没反应」的死帧
          pushedRef.current = false;
          window.history.back();
        } else {
          // 刷新残留：原地抹除标记即可；挂载路径上绝不能触发导航
          window.history.replaceState({}, "");
        }
      }
      return;
    }
    if (hasGuardFlag(window.history.state)) {
      if (pushedRef.current) return; // 哨兵已在栈顶（取消确认后恢复过）
      window.history.replaceState({}, ""); // 刷新残留：先抹再压
    }
    window.history.pushState({ [GUARD_FLAG]: Date.now() }, "");
    pushedRef.current = true;
    const onPop = () => {
      if (ignoreNextPopRef.current) {
        ignoreNextPopRef.current = false;
        return;
      }
      if (!dirtyRef.current) return;
      // 落回哨兵帧（前进/重复触发）仍在守卫中，无需动作
      if (hasGuardFlag(window.history.state)) return;
      popOriginRef.current = true;
      pendingRef.current = null;
      setConfirmOpen(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
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
        if (popOriginRef.current) {
          // 返回手势场景：哨兵帧已被弹出，再退一帧即真离开；
          // back 触发的下一次 popstate 是本动作自身，忽略
          popOriginRef.current = false;
          ignoreNextPopRef.current = true;
          window.history.back();
          return;
        }
        const pending = pendingRef.current;
        pendingRef.current = null;
        pending?.();
      }}
      onCancel={() => {
        setConfirmOpen(false);
        if (popOriginRef.current) {
          // 留在编辑：哨兵帧已在返回时被弹出，压回去恢复守卫
          popOriginRef.current = false;
          window.history.pushState({ [GUARD_FLAG]: Date.now() }, "");
        }
        pendingRef.current = null;
      }}
    />
  );

  return { attempt, dialog };
}
