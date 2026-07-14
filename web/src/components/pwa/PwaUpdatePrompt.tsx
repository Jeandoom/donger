import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "../ui/button";

export function PwaUpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!offlineReady && !needRefresh) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-[70] max-w-sm rounded-lg border border-border bg-background p-4 shadow-xl"
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
