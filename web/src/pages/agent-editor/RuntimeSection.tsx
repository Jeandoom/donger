import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Select } from "../../components/ui/select";
import {
  type AgentCallbackCreated,
  type AgentCallbackInfo,
  fetchAgentCallback,
  generateAgentCallback,
  revokeAgentCallback,
} from "../../lib/agents";
import { apiFetchRetry } from "../../lib/auth";
import {
  fetchShareStatus,
  removeShareGrant,
  type ShareStatus,
  setShareEnabled,
} from "../../lib/share";
import { cn } from "../../lib/utils";

/**
 * 运行管理带（specs/2026-09-29-agent-editor-ui-redesign.md §4/§5）：即时态面板集合。
 * 与表单分区物理分离——回调/分享/管家都是点按即生效的动作，不走「保存」、不受脏守卫管，
 * 因此不用 FormSection 序号卡，改虚线容器 + 「即时生效」徽标以示状态模型差异。
 * 移动端子面板手风琴化（收起一行「标题+状态摘要」），桌面平铺常开。
 */
export function RuntimeSection({ agentId }: { agentId: string }) {
  return (
    <section
      id="agent-sec-runtime"
      aria-labelledby="agent-sec-runtime-title"
      className="scroll-mt-28 rounded-xl border border-dashed border-border bg-card/50 p-4 md:p-6"
    >
      <header className="mb-1 flex items-center gap-2.5">
        <h2
          id="agent-sec-runtime-title"
          className="flex flex-wrap items-center gap-2 text-base font-semibold leading-6"
        >
          运行管理
          <Badge tone="info">即时生效 · 无需保存</Badge>
        </h2>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        对外发布与管家关系。以下动作点按立即生效，与上方配置的「保存」相互独立。
      </p>
      <div className="flex flex-col divide-y divide-border">
        <CallbackPanel agentId={agentId} />
        <SharePanel agentId={agentId} />
        <ManagedAppsPanel agentId={agentId} />
      </div>
    </section>
  );
}

/** 子面板头：标题 + 收起态摘要（仅移动端）+ 展开箭头（仅移动端可点，桌面 pointer-events 关闭） */
function PanelHeader({
  title,
  summary,
  open,
  onToggle,
}: {
  title: string;
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-2.5 text-left md:pointer-events-none"
    >
      <span className="shrink-0 text-[13px] font-semibold">{title}</span>
      {summary ? (
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs text-muted-foreground md:hidden",
            open && "hidden",
          )}
        >
          {summary}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <ChevronDown
        size={15}
        aria-hidden="true"
        className={cn(
          "shrink-0 text-muted-foreground transition-transform md:hidden",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

/** 手风琴内容区：移动端随 open 显隐，桌面恒显示 */
function PanelBody({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className={cn("flex-col gap-2.5 md:flex", open ? "flex" : "hidden")}>{children}</div>;
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
  const [open, setOpen] = useState(false);

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
  const summary = info?.configured
    ? expired
      ? "已过期"
      : `已配置 · …${info.tokenTail}`
    : "未配置";

  return (
    <div className="flex flex-col py-3.5 first:pt-0 last:pb-0">
      <PanelHeader
        title="回调链接（API）"
        summary={summary}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      <PanelBody open={open}>
        <div className="flex flex-wrap items-center gap-2.5">
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
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmRevoke(true)}
            >
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
      </PanelBody>
    </div>
  );
}

function SharePanel({ agentId }: { agentId: string }) {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetchShareStatus(agentId)
      .then(setStatus)
      .catch(() => {});
  }, [agentId]);

  const summary = status?.enabled ? `已授权 ${status.grants.length} 人` : "未开启";

  const toggle = async () => {
    if (!status) return;
    const next = await setShareEnabled(agentId, !status.enabled);
    setStatus({ ...status, ...next });
  };

  return (
    <div className="flex flex-col py-3.5 first:pt-0 last:pb-0">
      <PanelHeader
        title="共享给其他用户"
        summary={summary}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      <PanelBody open={open}>
        <div className="flex flex-wrap items-center gap-2.5">
          {status?.enabled ? <Badge tone="primary">已授权 {status.grants.length} 人</Badge> : null}
          <span className="flex-1" />
          <Button variant="secondary" size="sm" disabled={!status} onClick={() => void toggle()}>
            {status?.enabled ? "关闭分享" : "开启分享"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          开启后通过链接授权的用户可使用本智能体对话，但无权查看或编辑配置。
        </p>
        {status?.enabled && status.url ? (
          <>
            <input
              readOnly
              className="h-8 w-full rounded-lg border border-border bg-muted/40 px-2.5 font-mono text-xs"
              value={`${typeof window !== "undefined" ? window.location.origin : ""}${status.url}`}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground">访问者名单</span>
              {status.grants.map((g) => (
                <div
                  key={g.userId}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate font-mono text-xs">{g.userId}</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="shrink-0 text-xs text-destructive hover:underline"
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
      </PanelBody>
    </div>
  );
}

/** 管理的应用（应用管家制 spec §8）：反查视图——绑定关系在应用详情页改派，此处只读呈现 */
function ManagedAppsPanel({ agentId }: { agentId: string }) {
  const [apps, setApps] = useState<
    Array<{ id: string; name: string; currentVersion: number | null }>
  >([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    apiFetchRetry(`/api/apps?managedBy=${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ apps?: typeof apps }>) : { apps: [] }))
      .then((d) => setApps(d.apps ?? []))
      .catch(() => {});
  }, [agentId]);

  const summary = apps.length ? `${apps.length} 个应用` : "暂无";

  return (
    <div className="flex flex-col py-3.5 first:pt-0 last:pb-0">
      <PanelHeader
        title="管理的应用"
        summary={summary}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      <PanelBody open={open}>
        <p className="text-[11px] text-muted-foreground">
          该智能体担任责任管家的应用（会话内创建应用时自动绑定；改派在应用详情页操作）。
          管家身份会随身份节注入其全部会话，应用发布/回滚事件与反馈也路由到此。
        </p>
        {apps.length === 0 ? (
          <div className="text-xs text-muted-foreground">暂无绑定的应用。</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {apps.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2 text-[13px]"
              >
                <Link
                  to={`/apps/${a.id}`}
                  className="min-w-0 truncate text-primary hover:underline"
                >
                  {a.name}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {a.currentVersion !== null ? `v${a.currentVersion}` : "未发布"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </div>
  );
}
