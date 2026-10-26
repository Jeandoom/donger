import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "../ui/button";

export function PwaUpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  // 发布切换自动刷新（热发布 M4，spec 2026-10-16-hot-deploy-design §7.3）：
  // SSE 流恢复 = 服务已切到新实例，此时若有新 bundle 待激活则直接换血，
  // 不再停留旧 bundle（附件轮实锤过 SW prompt 模式用户滞留旧版的问题）
  useEffect(() => {
    if (!needRefresh) return;
    const autoUpdate = (): void => {
      void updateServiceWorker(true);
    };
    window.addEventListener("donger:stream-reconnected", autoUpdate);
    return () => window.removeEventListener("donger:stream-reconnected", autoUpdate);
  }, [needRefresh, updateServiceWorker]);

  if (!offlineReady && !needRefresh) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-[70] max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl"
    >
      <p className="text-sm">
        {needRefresh ? "发现新版本，确认后刷新应用。" : "应用外壳已可离线启动，聊天仍需联网。"}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        {needRefresh ? (
          <Button size="sm" onClick={() => void updateServiceWorker(true)}>
            刷新
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOfflineReady(false);
            setNeedRefresh(false);
          }}
        >
          稍后
        </Button>
      </div>
    </div>
  );
}
