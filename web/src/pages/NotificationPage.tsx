import { BellOff, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Switch } from "../components/ui/switch";
import { formatRelativeTime } from "../lib/agentSidebar";
import {
  fetchNotificationPrefs,
  fetchNotifications,
  groupNotificationsByTitle,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationChannel,
  type NotificationItem,
  type NotificationPrefGroup,
  SEVERITY_TONES,
  setNotificationPref,
} from "../lib/notifications";
import { cn } from "../lib/utils";

const PAGE_SIZE = 50;

/** 左侧导航两分区：通知列表 / 订阅偏好（投递地址已迁入连接器页「渠道连接」分区） */
type NotificationTab = "inbox" | "prefs";

const NAV_TABS: Array<{ id: NotificationTab; label: string }> = [
  { id: "inbox", label: "通知" },
  { id: "prefs", label: "订阅" },
];

const CHANNEL_COLUMNS: Array<{ id: NotificationChannel; label: string; hint: string }> = [
  { id: "inapp", label: "站内信", hint: "站内通知中心" },
  { id: "dingtalk", label: "钉钉", hint: "需绑定钉钉地址" },
  { id: "webhook", label: "Webhook", hint: "需配置出站端点" },
  { id: "email", label: "邮件", hint: "邮箱注册身份即收件地址；管理员在授权页配 SMTP" },
];

export function NotificationPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<NotificationTab>("inbox");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  // 默认未读视图：进页面先看没读过的
  const [unreadOnly, setUnreadOnly] = useState(true);
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

  const reloadPrefs = useCallback(() => {
    fetchNotificationPrefs()
      .then(setPrefs)
      .catch((reason: unknown) => {
        setPrefError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    reloadPrefs();
  }, [reloadPrefs]);

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

  const togglePref = (g: NotificationPrefGroup, channel: NotificationChannel, enabled: boolean) => {
    setPrefError(null);
    setNotificationPref(g.eventGroup, channel, enabled)
      .then(() => {
        setPrefs((prev) =>
          prev.map((x) =>
            x.eventGroup === g.eventGroup
              ? { ...x, channels: { ...x.channels, [channel]: enabled } }
              : x,
          ),
        );
      })
      .catch((reason: unknown) => {
        setPrefError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    // Shell 根是 h-[100dvh] overflow-hidden：页面必须自带滚动容器，否则内容溢出即被裁剪且无法滑动
    <div className="flex h-full w-full overflow-hidden">
      {/* 桌面：左侧分区导航 */}
      <nav className="hidden w-48 shrink-0 flex-col gap-1 border-r border-border bg-card/60 p-4 md:flex">
        <p className="px-3 pb-1 text-[11px] font-semibold text-muted-foreground/70">通知中心</p>
        {NAV_TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors",
                active
                  ? "bg-primary-soft font-semibold text-primary"
                  : "text-foreground hover:bg-muted",
              )}
            >
              {t.label}
              <span className="flex-1" />
              {t.id === "inbox" && unread > 0 ? <Badge tone="primary">{unread}</Badge> : null}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 移动端：横向分区 chips */}
        <nav className="no-scrollbar sticky top-0 z-10 flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card/95 px-4 py-2 backdrop-blur md:hidden">
          {NAV_TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground hover:opacity-80",
                )}
              >
                {t.label}
                {t.id === "inbox" && unread > 0 ? (
                  <span className="ml-1 font-semibold">{unread}</span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
            <PageHeader
              title="通知"
              description="通知列表、订阅偏好与投递地址：任务结果、循环运行、系统提醒、反馈回复统一在此触达"
            />

            {tab === "inbox" ? (
              <InboxCard
                items={items}
                total={total}
                unread={unread}
                unreadOnly={unreadOnly}
                loading={loading}
                loadError={loadError}
                onSwitchTab={(v) => setUnreadOnly(v)}
                onOpen={openItem}
                onMarkAll={markAll}
                onLoadMore={() => load(items.length, true)}
              />
            ) : null}

            {tab === "prefs" ? (
              <PrefsCard prefs={prefs} error={prefError} onToggle={togglePref} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function InboxCard(props: {
  items: NotificationItem[];
  total: number;
  unread: number;
  unreadOnly: boolean;
  loading: boolean;
  loadError: string | null;
  onSwitchTab: (unreadOnly: boolean) => void;
  onOpen: (n: NotificationItem) => void;
  onMarkAll: () => void;
  onLoadMore: () => void;
}) {
  const { items, total, unread, unreadOnly, loading, loadError } = props;
  // 未读视图按标题合并成会话式一行（自动化循环任务同标题刷屏）；已读视图逐条原样。
  // 本地已标记已读的条目（点了详情还没刷新）从合并组里即时剔除。
  const rows = unreadOnly
    ? groupNotificationsByTitle(items.filter((n) => !n.readAt))
    : items.map((n) => ({ title: n.title, latest: n, count: 1 }));
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-1 text-sm">
          <button
            type="button"
            className={cn(
              "min-h-8 rounded-lg px-2.5 transition-colors",
              unreadOnly ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => props.onSwitchTab(true)}
          >
            未读{unread > 0 ? ` (${unread})` : ""}
          </button>
          <button
            type="button"
            className={cn(
              "min-h-8 rounded-lg px-2.5 transition-colors",
              !unreadOnly ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => props.onSwitchTab(false)}
          >
            全部
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>共 {total} 条</span>
          <Button variant="ghost" size="sm" onClick={props.onMarkAll} disabled={unread === 0}>
            全部已读
          </Button>
        </div>
      </div>

      {loadError ? (
        <div className="px-4 py-6 text-sm text-red-600">加载失败：{loadError}</div>
      ) : rows.length === 0 && !loading ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-muted-foreground">
          <BellOff size={24} />
          <span className="text-sm">{unreadOnly ? "没有未读通知" : "暂无通知"}</span>
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const n = row.latest;
            return (
              <li key={unreadOnly ? row.title : n.id}>
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
                    onClick={() => props.onOpen(n)}
                  >
                    <span className="flex items-center gap-2">
                      {!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                      <span className={cn("text-sm", !n.readAt && "font-medium")}>{n.title}</span>
                      {row.count > 1 && (
                        <Badge tone="primary" className="min-w-5 justify-center px-1.5">
                          {row.count}
                        </Badge>
                      )}
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
                      onClick={() => props.onOpen(n)}
                    >
                      详情
                      <ChevronRight size={14} />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {items.length < total ? (
        <div className="border-t px-4 py-2 text-center">
          <Button variant="ghost" size="sm" disabled={loading} onClick={props.onLoadMore}>
            {loading ? "加载中…" : "加载更多"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function PrefsCard(props: {
  prefs: NotificationPrefGroup[];
  error: string | null;
  onToggle: (g: NotificationPrefGroup, channel: NotificationChannel, enabled: boolean) => void;
}) {
  return (
    <Card className="flex flex-col">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium">订阅偏好</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          控制三类通知（系统/工作流/智能体）投递到哪些渠道；站外渠道按通知类型订阅（opt-in），未订阅或未配置地址时消息转为系统通知并累计提醒
        </p>
      </div>
      {props.error ? <div className="px-4 py-3 text-sm text-red-600">{props.error}</div> : null}
      <div className="hidden grid-cols-4 gap-2 border-b px-4 py-2 text-[11px] text-muted-foreground sm:grid">
        <span />
        {CHANNEL_COLUMNS.map((c) => (
          <span key={c.id} className="text-center">
            {c.label}
            <span className="block text-[10px] opacity-70">{c.hint}</span>
          </span>
        ))}
      </div>
      <ul className="divide-y">
        {props.prefs.map((g) => (
          <li
            key={g.eventGroup}
            className="grid grid-cols-1 items-center gap-3 px-4 py-3 sm:grid-cols-4"
          >
            <div className="min-w-0">
              <div className="text-sm">{g.label}</div>
              {g.mandatory ? (
                <div className="text-[11px] text-muted-foreground">安全相关，站内信不可关闭</div>
              ) : null}
            </div>
            {CHANNEL_COLUMNS.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 sm:justify-center">
                <span className="text-xs text-muted-foreground sm:hidden">{c.label}</span>
                <Switch
                  checked={g.channels[c.id]}
                  disabled={g.mandatory && c.id === "inapp"}
                  onCheckedChange={(v) => props.onToggle(g, c.id, v)}
                  aria-label={`${g.label}·${c.label}`}
                />
              </div>
            ))}
          </li>
        ))}
        {props.prefs.length === 0 && !props.error ? (
          <li className="px-4 py-4 text-sm text-muted-foreground">加载中…</li>
        ) : null}
      </ul>
    </Card>
  );
}

