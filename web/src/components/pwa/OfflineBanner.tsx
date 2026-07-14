import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const setOnlineState = () => setOnline(true);
    const setOfflineState = () => setOnline(false);
    window.addEventListener("online", setOnlineState);
    window.addEventListener("offline", setOfflineState);
    return () => {
      window.removeEventListener("online", setOnlineState);
      window.removeEventListener("offline", setOfflineState);
    };
  }, []);

  if (online) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[70] bg-yellow-500 px-3 py-2 text-center text-sm text-black"
    >
      当前离线，聊天功能需要联网
    </div>
  );
}
