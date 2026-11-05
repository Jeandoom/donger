import { useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import {
  type AddressesView,
  confirmDingTalkVerify,
  deleteNotificationAddress,
  requestDingTalkVerify,
  saveWebhookAddress,
  testNotificationAddress,
} from "../lib/notifications";

/** 投递地址簿（钉钉绑定 + webhook 出站端点；渠道连接分区与通知页共用） */
export function AddressBookCard(props: { addresses: AddressesView | null; onChanged: () => void }) {
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
