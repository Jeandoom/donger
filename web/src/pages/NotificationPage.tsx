import { BellOff, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Switch } from "../components/ui/switch";
import { formatRelativeTime } from "../lib/agentSidebar";
import {
  type AddressesView,
  confirmDingTalkVerify,
  deleteNotificationAddress,
  fetchAddresses,
  fetchNotificationPrefs,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationChannel,
  type NotificationItem,
  type NotificationPrefGroup,
  requestDingTalkVerify,
  SEVERITY_TONES,
  saveWebhookAddress,
  setNotificationPref,
  testNotificationAddress,
} from "../lib/notifications";
import { cn } from "../lib/utils";

const PAGE_SIZE = 50;

const CHANNEL_COLUMNS: Array<{ id: NotificationChannel; label: string; hint: string }> = [
  { id: "inapp", label: "站内信", hint: "站内通知中心" },
  { id: "dingtalk", label: "钉钉", hint: "需绑定钉钉地址" },
  { id: "webhook", label: "Webhook", hint: "需配置出站端点" },
];

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
  const [addresses, setAddresses] = useState<AddressesView | null>(null);

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
    fetchAddresses()
      .then(setAddresses)
      .catch(() => {});
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

  const reloadAddresses = () => {
    fetchAddresses()
      .then(setAddresses)
      .catch(() => {});
  };

  return (
    // Shell 根是 h-[100dvh] overflow-hidden：页面必须自带滚动容器，否则内容溢出即被裁剪且无法滑动
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto p-4">
      <PageHeader
        title="通知"
        description="站内信中心与订阅偏好：任务结果、循环运行、系统提醒、反馈回复统一在此触达"
      />

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

      <PrefsCard prefs={prefs} error={prefError} onToggle={togglePref} />

      <AddressBookCard addresses={addresses} onChanged={reloadAddresses} />
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
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-1 text-sm">
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
                  onClick={() => props.onOpen(n)}
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
                    onClick={() => props.onOpen(n)}
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
          控制各类通知投递到哪些通道；站外通道按事件组订阅（opt-in），通道未配置时投递自动跳过
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

function AddressBookCard(props: { addresses: AddressesView | null; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (fn: () => Promise<void>, okMsg?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    fn()
      .then(() => {
        if (okMsg) setNotice(okMsg);
        props.onChanged();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setBusy(false));
  };

  const dt = props.addresses?.dingtalk;
  const hook = props.addresses?.webhook;

  return (
    <Card className="flex flex-col">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium">投递地址</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          站外通道的投递目标：钉钉单聊（staffId）与出站 Webhook
        </p>
      </div>
      {error ? <div className="px-4 py-2 text-sm text-red-600">{error}</div> : null}
      {notice ? <div className="px-4 py-2 text-sm text-emerald-600">{notice}</div> : null}
      <ul className="divide-y">
        <li className="px-4 py-3">
          <DingTalkAddress view={dt ?? null} busy={busy} onRun={run} />
        </li>
        <li className="px-4 py-3">
          <WebhookAddress view={hook ?? null} busy={busy} onRun={run} />
        </li>
      </ul>
    </Card>
  );
}

function DingTalkAddress(props: {
  view: AddressesView["dingtalk"] | null;
  busy: boolean;
  onRun: (fn: () => Promise<void>, okMsg?: string) => void;
}) {
  const [staffId, setStaffId] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"input" | "code">("input");
  const dt = props.view;
  const bound = !!dt?.staffId;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">钉钉单聊</div>
        {bound ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={() =>
                props.onRun(
                  () => testNotificationAddress("dingtalk"),
                  "测试消息已发送，请在钉钉查收",
                )
              }
            >
              发送测试
            </Button>
            {dt?.source === "manual" ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={props.busy}
                onClick={() =>
                  props.onRun(() => deleteNotificationAddress("dingtalk"), "已解除钉钉绑定")
                }
              >
                解除绑定
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {bound ? (
        <div className="text-xs text-muted-foreground">
          {dt?.source === "login" ? "已通过钉钉登录自动绑定" : "已验证绑定"}：
          <code className="rounded bg-muted px-1 py-0.5">{dt?.staffId}</code>
        </div>
      ) : stage === "input" ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            placeholder="钉钉 staffId（企业内部应用用户 ID）"
            className="sm:max-w-xs"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={props.busy || !staffId.trim()}
            onClick={() =>
              props.onRun(async () => {
                await requestDingTalkVerify(staffId.trim());
                setStage("code");
              }, "验证码已发送到该钉钉账号，请查收")
            }
          >
            获取验证码
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6 位验证码"
            className="sm:max-w-[10rem]"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={props.busy || code.length !== 6}
            onClick={() =>
              props.onRun(async () => {
                await confirmDingTalkVerify(code);
                setStage("input");
                setStaffId("");
                setCode("");
              }, "钉钉地址绑定成功")
            }
          >
            完成绑定
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setStage("input")}>
            取消
          </Button>
        </div>
      )}
    </div>
  );
}

function WebhookAddress(props: {
  view: AddressesView["webhook"];
  busy: boolean;
  onRun: (fn: () => Promise<void>, okMsg?: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const hook = props.view;

  const parseHeaders = (): Record<string, string> | undefined => {
    const entries = headersText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(":");
        return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : null;
      })
      .filter((p): p is [string, string] => !!p && !!p[0] && !!p[1]);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">Webhook 出站</div>
        {hook ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={() =>
                props.onRun(() => testNotificationAddress("webhook"), "测试请求已发送")
              }
            >
              发送测试
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={() =>
                props.onRun(() => deleteNotificationAddress("webhook"), "已删除 webhook 地址")
              }
            >
              删除
            </Button>
          </div>
        ) : null}
      </div>
      {hook ? (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <div>
            <code className="break-all rounded bg-muted px-1 py-0.5">{hook.url}</code>
          </div>
          {hook.secret ? (
            <div>
              签名密钥（HMAC-SHA256，头 <code>X-Donger-Signature</code> = sign(ts + "." + body)）：
              <code className="ml-1 break-all rounded bg-muted px-1 py-0.5">{hook.secret}</code>
            </div>
          ) : null}
          {hook.headerKeys.length > 0 ? (
            <div>自定义头：{hook.headerKeys.join("、")}（值不回显）</div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={hook?.url ?? url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/hook（仅公网目标）"
          className="sm:max-w-md"
          disabled={!!hook}
        />
      </div>
      {!hook ? (
        <textarea
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          placeholder="自定义请求头（可选，每行 Key: Value；值加密存储不回显）"
          rows={2}
          className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-ring sm:max-w-md"
        />
      ) : null}
      {!hook ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={props.busy || !url.trim()}
            onClick={() =>
              props.onRun(async () => {
                const probe = await saveWebhookAddress({
                  url: url.trim(),
                  headers: parseHeaders(),
                });
                setUrl("");
                setHeadersText("");
                if (!probe.reachable) {
                  throw new Error(
                    `已保存，但连通性验证未通过：${probe.detail ?? "目标无响应"}（保存成功，可稍后用「发送测试」复查）`,
                  );
                }
              }, "webhook 地址已保存，连通性验证通过")
            }
          >
            保存并验证
          </Button>
        </div>
      ) : null}
    </div>
  );
}
