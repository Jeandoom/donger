import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { AddressBookCard } from "../AddressBookCard";
import type { AddressesView } from "../../lib/notifications";
import {
  type ChannelConnectionDTO,
  fetchChannelConfig,
  saveChannelConfig,
} from "../../lib/channelConnections";

/** 能力徽标：适配 ✓ / 暂未适配（拍板 #2：能力声明制，未适配灰标展示） */
function CapabilityBadge({ label, adapted }: { label: string; adapted: boolean }) {
  return adapted ? (
    <Badge tone="success">{label}</Badge>
  ) : (
    <Badge tone="neutral">暂未适配</Badge>
  );
}

/**
 * 渠道连接视图（2026-11-05 统一通知设计 §2.2）：连接器页 tab2。
 * 渠道卡片=能力徽标（出站推送/回原/入站）+ 配置来源 + 连通性测试 + 入站监听状态；
 * 按用户地址簿配置的渠道（钉钉/webhook）内嵌投递地址簿（自通知中心「推送」分区迁入）。
 */
export function ChannelConnectionsView(props: {
  channels: ChannelConnectionDTO[];
  loading: boolean;
  error: string;
  isAdmin: boolean;
  testingId: string | null;
  testOutcomes: Record<string, { ok: boolean; error?: string; detail?: string }>;
  addresses: AddressesView | null;
  onTest: (id: string) => void;
  onReload: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        渠道连接：通知/消息渠道的一等资产入口——对接配置与连通性测试、入站监听状态、
        投递地址簿。出站投递最终与
        <span className="font-medium text-foreground">通知中心的渠道订阅</span>
        取交集生效；新平台接入只需在实现层注册渠道适配器。
      </p>

      {props.error ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          <span>{props.error}</span>
          <Button variant="outline" size="sm" onClick={props.onReload}>
            重试
          </Button>
        </div>
      ) : null}

      {props.loading ? (
        <div className="space-y-3" aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : (
        props.channels.map((c) => {
          const outcome = props.testOutcomes[c.id];
          const inbound = c.status?.inbound as
            | { mode?: string; connected?: boolean; detail?: string }
            | undefined;
          const inboundAdapted = c.capabilities.inbound !== null;
          const inboundLabel =
            c.capabilities.inbound === "webhook"
              ? "入站 Webhook"
              : c.capabilities.inbound === "stream"
                ? "入站长连接"
                : c.capabilities.inbound === "pull"
                  ? "入站拉取"
                  : "入站";
          const hasAddressBook = c.id === "dingtalk" || c.id === "webhook";
          return (
            <Card key={c.id} className="flex flex-col gap-3 p-4">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{c.displayName}</span>
                    <Badge tone={c.available ? "success" : "neutral"}>
                      {c.available ? "可用" : "未启用"}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
                </div>
                {props.isAdmin ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={props.testingId === c.id}
                    onClick={() => props.onTest(c.id)}
                  >
                    {props.testingId === c.id ? "测试中…" : "测试连接"}
                  </Button>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <CapabilityBadge label="出站推送" adapted={c.capabilities.outboundPush} />
                <CapabilityBadge label="回复来源" adapted={c.capabilities.replyToSource} />
                <CapabilityBadge label={inboundLabel} adapted={inboundAdapted} />
                <Badge tone="info">{c.configHint}</Badge>
              </div>

              {inbound ? (
                <p className="text-xs text-muted-foreground">
                  入站监听（{inbound.mode}）：
                  <span className={inbound.connected ? "text-success" : ""}>
                    {inbound.connected ? "在线" : "离线"}
                  </span>
                  {inbound.detail ? ` · ${inbound.detail}` : ""}
                </p>
              ) : null}

              {outcome ? (
                <p
                  className={
                    outcome.ok
                      ? "text-xs text-success"
                      : "text-xs text-destructive"
                  }
                >
                  {outcome.ok ? "✓ 连通" : `✗ ${outcome.error ?? "测试失败"}`}
                  {outcome.detail ? ` · ${outcome.detail}` : ""}
                </p>
              ) : null}

              {c.configSource === "connection" && props.isAdmin ? (
                <ConnectionConfigForm platform={c.id} onSaved={props.onReload} />
              ) : null}

              {hasAddressBook ? (
                <div className="border-t pt-3">
                  <div className="mb-2 text-xs font-semibold text-muted-foreground">
                    投递地址簿（按用户）
                  </div>
                  <AddressBookCard addresses={props.addresses} onChanged={props.onReload} />
                </div>
              ) : c.configSource === "module_configs" ? (
                <p className="text-xs text-muted-foreground">
                  配置在授权页管理（渠道连接只读引用 + 连通性测试）
                </p>
              ) : null}
            </Card>
          );
        })
      )}
    </div>
  );
}

/** 渠道自持配置表单（connection 渠道；secret 保存后永不回显，重填即覆盖） */
function ConnectionConfigForm(props: { platform: string; onSaved: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    setLoaded(true);
    fetchChannelConfig(props.platform)
      .then((view) => {
        setConfigured(view.configured);
        setEnabled(view.enabled);
      })
      .catch(() => {});
  }

  const save = () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const config: Record<string, string> = { appId, appSecret };
    if (verificationToken) config.verificationToken = verificationToken;
    saveChannelConfig(props.platform, config, enabled)
      .then(() => {
        setConfigured(true);
        setAppSecret("");
        setNotice("已保存并生效（测试连接可验证连通性）");
        props.onSaved();
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="border-t pt-3">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-xs font-semibold text-muted-foreground">连接配置</span>
        {configured !== null ? (
          <Badge tone={configured ? "success" : "neutral"}>
            {configured ? "已配置" : "未配置"}
          </Badge>
        ) : null}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={enabled}
            disabled={!configured}
            onCheckedChange={(v) => setEnabled(v)}
            aria-label="启用渠道"
          />
          启用
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <Input
          placeholder="App ID"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          className="max-w-sm"
        />
        <Input
          placeholder="App Secret（保存后不回显；留空=保留原值）"
          type="password"
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
          className="max-w-sm"
        />
        <Input
          placeholder="Verification Token（事件订阅校验，可选）"
          value={verificationToken}
          onChange={(e) => setVerificationToken(e.target.value)}
          className="max-w-sm"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {notice ? <p className="text-xs text-success">{notice}</p> : null}
        <Button size="sm" variant="secondary" disabled={busy || !appId} onClick={save}>
          {busy ? "保存中…" : "保存配置"}
        </Button>
      </div>
    </div>
  );
}
