import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 探测目标：/api/health 免鉴权，且在 SW NavigationRoute denylist（/^\/api\//）内，
 * 请求必回源而非命中预缓存，因此可作为真实网络连通性探针。
 */
const PROBE_URL = "/api/health";
const PROBE_TIMEOUT_MS = 5000;
const REPROBE_INTERVAL_MS = 10000;

async function probeReachable(signal: AbortSignal): Promise<boolean> {
  try {
    // 任意 HTTP 响应（含 4xx/5xx）都证明网络可达；只有请求抛错（断网/超时）才算离线
    await fetch(PROBE_URL, { method: "HEAD", cache: "no-store", signal });
    return true;
  } catch {
    return false;
  }
}

/**
 * 离线横幅：不盲信 navigator.onLine / offline 事件——部分移动浏览器会持续误报离线
 * （实测：页面 API 数据加载正常却恒报 offline）。出现"疑似离线"信号后先真实探测，
 * 探测失败才展示横幅；横幅展示期间周期复测，恢复后自动消失。
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const suspectRef = useRef(false);
  const reprobeTimerRef = useRef<number | undefined>(undefined);
  const probeSeqRef = useRef(0);

  const stopProbing = useCallback(() => {
    suspectRef.current = false;
    window.clearInterval(reprobeTimerRef.current);
    reprobeTimerRef.current = undefined;
  }, []);

  const probeNow = useCallback(() => {
    const seq = ++probeSeqRef.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    void probeReachable(controller.signal).then((reachable) => {
      window.clearTimeout(timeout);
      if (seq !== probeSeqRef.current) return;
      if (reachable) {
        stopProbing();
        setOffline(false);
      } else {
        setOffline(true);
      }
    });
  }, [stopProbing]);

  const enterSuspect = useCallback(() => {
    if (suspectRef.current) return;
    suspectRef.current = true;
    probeNow();
    reprobeTimerRef.current = window.setInterval(probeNow, REPROBE_INTERVAL_MS);
  }, [probeNow]);

  useEffect(() => {
    if (!navigator.onLine) enterSuspect();
    const onOffline = () => enterSuspect();
    const onOnline = () => {
      stopProbing();
      probeSeqRef.current += 1;
      setOffline(false);
    };
    const onVisible = () => {
      if (suspectRef.current && document.visibilityState === "visible") probeNow();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      stopProbing();
    };
  }, [enterSuspect, probeNow, stopProbing]);

  if (!offline) return null;
  return (
    <div
      role="status"
      className="shrink-0 bg-warning-soft px-3 py-2 text-center text-sm font-medium text-amber-800"
    >
      当前离线，聊天功能需要联网
    </div>
  );
}
