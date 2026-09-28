import { BellOff, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { Switch } from "../components/ui/switch";
import { formatRelativeTime } from "../lib/agentSidebar";
import {
  fetchNotificationPrefs,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
  type NotificationPrefGroup,
  SEVERITY_TONES,
  setNotificationPref,
} from "../lib/notifications";
import { cn } from "../lib/utils";

const PAGE_SIZE = 50;

export function NotificationPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefGroup[]>([]);
  const [prefError, setPrefError] = useState<string | null>(null);

  const load = useCallback(
    (offset: number, append: boolean) => {
      setLoading(true);
      setLoadError(null);
      fetchNotifications({ limit: PAGE_SIZE, offset, unreadOnly })
        .then((r) => {
          setItems((prev) => (append ? [...prev, ...r.items] : r.items));
          setTotal(r.total);
          setUnread(r.unread);
        })
        .catch((reason: unknown) => {
          setLoadError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => setLoading(false));
    },
    [unreadOnly],
  );

  useEffect(() => {
    load(0, false);
  }, [load]);

  useEffect(() => {
    fetchNotificationPrefs()
      .then(setPrefs)
      .catch((reason: unknown) => {
        setPrefError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const openItem = (n: NotificationItem) => {
    if (!n.readAt) {
      markNotificationRead(n.id)
        .then(() => {
          setItems((prev) =>
            prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)),
          );
          setUnread((u) => Math.max(0, u - 1));
        })
        .catch(() => {});
    }
    if (n.link) navigate(n.link);
  };

  const markAll = () => {
    markAllNotificationsRead()
      .then(() => load(0, false))
      .catch(() => {});
  };

  const togglePref = (g: NotificationPrefGroup, enabled: boolean) => {
    setPrefError(null);
    setNotificationPref(g.eventGroup, enabled)
      .then(() => {
        setPrefs((prev) =>
          prev.map((x) => (x.eventGroup === g.eventGroup ? { ...x, inapp: enabled } : x)),
        );
      })
      .catch((reason: unknown) => {
        setPrefError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <PageHeader
        title="通知"
        description="站内信中心与订阅偏好：任务结果、循环运行、系统提醒、反馈回复统一在此触达"
      />

      <Card className="flex flex-col">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-1 text-sm">
            <button
              type="button"
              className={cn(
                "min-h-8 rounded-lg px-2.5 transition-colors",
                !unreadOnly
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setUnreadOnly(false)}
            >
              全部
            </button>
            <button
              type="button"
              className={cn(
                "min-h-8 rounded-lg px-2.5 transition-colors",
                unreadOnly
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setUnreadOnly(true)}
            >
              未读{unread > 0 ? ` (${unread})` : ""}
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>共 {total} 条</span>
            <Button variant="ghost" size="sm" onClick={markAll} disabled={unread === 0}>
              全部已读
            </Button>
          </div>
        </div>

        {loadError ? (
          <div className="px-4 py-6 text-sm text-red-600">加载失败：{loadError}</div>
        ) : items.length === 0 && !loading ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-muted-foreground">
            <BellOff size={24} />
            <span className="text-sm">{unreadOnly ? "没有未读通知" : "暂无通知"}</span>
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((n) => (
              <li key={n.id}>
                {/* 内容区与「详情」为兄弟按钮（不可嵌套）：点内容或点详情都=标已读+跳对应功能位置 */}
                <div
                  className={cn(
                    "flex items-center gap-2 px-4 py-3 transition-colors hover:bg-accent/50",
                    !n.readAt && "bg-primary/[0.04]",
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer text-left"
                    onClick={() => openItem(n)}
                  >
                    <span className="flex items-center gap-2">
                      {!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                      <span className={cn("text-sm", !n.readAt && "font-medium")}>{n.title}</span>
                      <span className={cn("text-[11px]", SEVERITY_TONES[n.severity])}>
                        {n.severity === "critical" ? "严重" : n.severity === "warn" ? "警告" : ""}
                      </span>
                      <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">
                        {formatRelativeTime(n.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block pl-4 text-xs text-muted-foreground">
                      {n.body}
                    </span>
                  </button>
                  {n.link && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      onClick={() => openItem(n)}
                    >
                      详情
                      <ChevronRight size={14} />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {items.length < total ? (
          <div className="border-t px-4 py-2 text-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => load(items.length, true)}
            >
              {loading ? "加载中…" : "加载更多"}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-col">
        <div className="border-b px-4 py-3">
          <div className="text-sm font-medium">订阅偏好</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            控制各类通知是否送达站内信；站外通道（钉钉/Webhook/邮件）将随后续版本在此加入
          </p>
        </div>
        {prefError ? <div className="px-4 py-3 text-sm text-red-600">{prefError}</div> : null}
        <ul className="divide-y">
          {prefs.map((g) => (
            <li key={g.eventGroup} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm">{g.label}</div>
                {g.mandatory ? (
                  <div className="text-[11px] text-muted-foreground">安全相关通知，不可关闭</div>
                ) : null}
              </div>
              <Switch
                checked={g.inapp}
                disabled={g.mandatory}
                onCheckedChange={(v) => togglePref(g, v)}
                aria-label={`站内信：${g.label}`}
              />
            </li>
          ))}
          {prefs.length === 0 && !prefError ? (
            <li className="px-4 py-4 text-sm text-muted-foreground">加载中…</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
