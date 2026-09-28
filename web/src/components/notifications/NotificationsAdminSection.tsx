// 授权页「通知」admin 分区：通道状态 + 投递日志 + 系统公告群发
// （spec 2026-09-28-notification-module-design §8 管理端）

import { useCallback, useEffect, useState } from "react";
import { formatRelativeTime } from "../../lib/agentSidebar";
import {
  fetchNotificationDeliveries,
  fetchNotificationStatus,
  type NotificationChannelStatus,
  type NotificationDeliveryRow,
  sendAnnouncement,
} from "../../lib/notifications";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

const CHANNEL_LABELS: Record<string, string> = {
  inapp: "站内信",
  dingtalk: "钉钉单聊",
  webhook: "Webhook",
};

const STATUS_LABELS: Record<NotificationDeliveryRow["status"], string> = {
  ok: "成功",
  failed: "失败",
  skipped: "跳过",
};

export function NotificationsAdminSection() {
  const [status, setStatus] = useState<NotificationChannelStatus | null>(null);
  const [deliveries, setDeliveries] = useState<NotificationDeliveryRow[]>([]);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<"info" | "warn" | "critical">("info");
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    setLoadError("");
    Promise.all([fetchNotificationStatus(), fetchNotificationDeliveries(50)])
      .then(([s, d]) => {
        setStatus(s);
        setDeliveries(d);
      })
      .catch((reason: unknown) => {
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const doSend = () => {
    setSending(true);
    setSendMsg(null);
    sendAnnouncement({ title: title.trim(), body: body.trim(), severity })
      .then((recipients) => {
        setSendMsg({ ok: true, text: `公告已发往 ${recipients} 个用户（按各自订阅投递）` });
        setTitle("");
        setBody("");
        load();
      })
      .catch((reason: unknown) => {
        setSendMsg({
          ok: false,
          text: reason instanceof Error ? reason.message : String(reason),
        });
      })
      .finally(() => setSending(false));
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            通知通道状态
            {status ? <Badge tone="neutral">运行中</Badge> : <Badge tone="neutral">加载中</Badge>}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            站内信恒开；钉钉复用「钉钉登录」分区的机器人凭据（需 robotCode）；webhook
            为用户自配出站端点，无全局开关
          </p>
        </div>
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
        {status ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {Object.entries(status).map(([id, ok]) => (
              <div
                key={id}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span>{CHANNEL_LABELS[id] ?? id}</span>
                <Badge tone={ok ? "success" : "neutral"}>{ok ? "可用" : "未配置"}</Badge>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold">系统公告</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            向全部用户发一条站内信；开启站外订阅的用户按其偏好同步收到钉钉/Webhook
          </p>
        </div>
        {sendMsg ? (
          <p className={`text-sm ${sendMsg.ok ? "text-success" : "text-destructive"}`}>
            {sendMsg.text}
          </p>
        ) : null}
        <div className="space-y-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="公告标题（≤200 字）"
            maxLength={200}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="公告内容（≤2000 字）"
            rows={3}
            maxLength={2000}
            className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as typeof severity)}
              className="w-32"
            >
              <option value="info">提示</option>
              <option value="warn">警告</option>
              <option value="critical">严重</option>
            </Select>
            <Button size="sm" disabled={sending || !title.trim() || !body.trim()} onClick={doSend}>
              {sending ? "发送中…" : "发送公告"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">投递日志</h2>
            <p className="mt-1 text-xs text-muted-foreground">最近 50 条站外通道投递结果</p>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            刷新
          </Button>
        </div>
        {deliveries.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">暂无投递记录</p>
        ) : (
          <ul className="mt-3 divide-y text-sm">
            {deliveries.map((d) => (
              <li key={d.id} className="flex flex-col gap-0.5 py-2">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      d.status === "ok" ? "success" : d.status === "failed" ? "danger" : "neutral"
                    }
                  >
                    {STATUS_LABELS[d.status]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {CHANNEL_LABELS[d.channel] ?? d.channel}
                  </span>
                  <span className="truncate text-xs">{d.title}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatRelativeTime(d.createdAt)}
                    {d.attempts > 1 ? ` · ${d.attempts} 次` : ""}
                  </span>
                </div>
                {d.error ? (
                  <p className="truncate pl-1 text-[11px] text-muted-foreground">{d.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
