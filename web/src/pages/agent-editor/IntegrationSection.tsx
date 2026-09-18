import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { FormSection } from "../../components/ui/form-section";
import { Select } from "../../components/ui/select";
import {
  type AgentCallbackCreated,
  type AgentCallbackInfo,
  fetchAgentCallback,
  generateAgentCallback,
  revokeAgentCallback,
} from "../../lib/agents";
import {
  fetchShareStatus,
  removeShareGrant,
  type ShareStatus,
  setShareEnabled,
} from "../../lib/share";

export function IntegrationSection({ agentId }: { agentId: string }) {
  return (
    <FormSection
      id="agent-sec-integration"
      no="5"
      title="集成与分享"
      description="对外发布：API 回调链接与共享授权"
    >
      <CallbackPanel agentId={agentId} />
      <SharePanel agentId={agentId} />
    </FormSection>
  );
}

const CALLBACK_VALIDITY_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 360, label: "360 天" },
  { days: 180, label: "180 天" },
  { days: 30, label: "30 天" },
  { days: 0, label: "不过期" },
];

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "永久有效";
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return "未知";
  if (t <= Date.now()) return `已于 ${new Date(t).toLocaleString()} 过期`;
  return `有效期至 ${new Date(t).toLocaleString()}`;
}

/**
 * 回调链接面板：生成带有效期的回调 URL，调用方 GET ?query=xxx 即与该智能体对话。
 * 链接等同该智能体的 API 密钥——完整 URL 仅生成时展示一次，之后只显尾 4 位。
 */
function CallbackPanel({ agentId }: { agentId: string }) {
  const [info, setInfo] = useState<AgentCallbackInfo | null>(null);
  const [validityDays, setValidityDays] = useState<number>(30);
  const [created, setCreated] = useState<AgentCallbackCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    fetchAgentCallback(agentId)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [agentId]);

  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await generateAgentCallback(agentId, validityDays || undefined);
      setCreated(res);
      setCopied(false);
      setInfo({
        configured: true,
        tokenTail: res.token.slice(-4),
        expiresAt: res.expiresAt,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError("");
    try {
      await revokeAgentCallback(agentId);
      setCreated(null);
      setInfo({ configured: false, tokenTail: null, expiresAt: null, createdAt: null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时用户可手动选中输入框文本复制
      setCopied(false);
    }
  };

  const expired = Boolean(info?.expiresAt && new Date(info.expiresAt).getTime() <= Date.now());

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[13px] font-semibold">回调链接（API）</span>
        {info?.configured ? (
          <>
            <Badge tone="success">已配置 · …{info.tokenTail}</Badge>
            {expired ? <Badge tone="danger">已过期</Badge> : null}
            <span className="text-xs text-muted-foreground">{formatExpiry(info.expiresAt)}</span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            未配置。生成后调用方访问该链接即可与本智能体对话。
          </span>
        )}
        <span className="flex-1" />
        <Select
          className="w-28"
          value={validityDays}
          onChange={(e) => setValidityDays(Number(e.target.value))}
        >
          {CALLBACK_VALIDITY_OPTIONS.map((o) => (
            <option key={o.days} value={o.days}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => (info?.configured ? setConfirmRegen(true) : void generate())}
        >
          {info?.configured ? "重新生成" : "生成链接"}
        </Button>
        {info?.configured ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmRevoke(true)}>
            吊销
          </Button>
        ) : null}
      </div>

      {created ? (
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-muted/40 p-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 font-mono text-xs"
              value={`${created.url}?query=你的问题`}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button variant="secondary" size="sm" onClick={() => void copyUrl()}>
              {copied ? "已复制" : "复制"}
            </Button>
            <Badge tone="warning">仅显示一次</Badge>
          </div>
          <p className="text-[11px] text-warning">
            完整链接仅此次显示，请立即复制保存；重新生成将使旧链接立即失效。
          </p>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        用法：<code className="rounded bg-muted px-1 py-0.5">GET 回调链接?query=问题</code>
        即发起一次对话（每次独立会话）；回调对话以 Full access
        执行（免人工审批，工具白名单与写入边界守卫仍生效）；query 经 URL
        明文传输，请勿传递敏感内容。
      </p>

      <ConfirmDialog
        open={confirmRegen}
        title="重新生成回调链接？"
        description="重新生成将立即作废当前回调链接，确认继续？"
        confirmText="重新生成"
        busy={busy}
        onConfirm={() => {
          setConfirmRegen(false);
          void generate();
        }}
        onCancel={() => setConfirmRegen(false)}
      />
      <ConfirmDialog
        open={confirmRevoke}
        title="吊销回调链接？"
        description="吊销后调用方将立即无法使用该链接。"
        confirmText="吊销"
        destructive
        busy={busy}
        onConfirm={() => {
          setConfirmRevoke(false);
          void revoke();
        }}
        onCancel={() => setConfirmRevoke(false)}
      />
    </div>
  );
}

function SharePanel({ agentId }: { agentId: string }) {
  const [status, setStatus] = useState<ShareStatus | null>(null);

  useEffect(() => {
    fetchShareStatus(agentId)
      .then(setStatus)
      .catch(() => {});
  }, [agentId]);

  if (!status) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const toggle = async () => {
    const next = await setShareEnabled(agentId, !status.enabled);
    setStatus({ ...status, ...next });
  };

  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[13px] font-semibold">共享给其他用户</span>
        {status.enabled ? <Badge tone="primary">已授权 {status.grants.length} 人</Badge> : null}
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => void toggle()}>
          {status.enabled ? "关闭分享" : "开启分享"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        开启后通过链接授权的用户可使用本智能体对话，但无权查看或编辑配置。
      </p>
      {status.enabled && status.url ? (
        <>
          <input
            readOnly
            className="h-8 w-full rounded-lg border border-border bg-muted/40 px-2.5 font-mono text-xs"
            value={`${origin}${status.url}`}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-muted-foreground">访问者名单</span>
            {status.grants.map((g) => (
              <div
                key={g.userId}
                className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
              >
                <span className="font-mono text-xs">{g.userId}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="text-xs text-destructive hover:underline"
                  onClick={async () => {
                    await removeShareGrant(agentId, g.userId);
                    setStatus({
                      ...status,
                      grants: status.grants.filter((x) => x.userId !== g.userId),
                    });
                  }}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
