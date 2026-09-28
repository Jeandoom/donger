import { useCallback, useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { apiFetch } from "../lib/auth";

interface Invite {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  disabled: boolean;
}

function inviteStatus(
  invite: Invite,
  now: number,
): { label: string; tone: "success" | "warning" | "neutral" } {
  if (invite.disabled) return { label: "已禁用", tone: "neutral" };
  if (new Date(invite.expiresAt).getTime() <= now) return { label: "已过期", tone: "neutral" };
  if (invite.usedCount >= invite.maxUses) return { label: "已用完", tone: "warning" };
  return { label: "有效", tone: "success" };
}

function registerLink(token: string): string {
  return `${window.location.origin}/register?invite=${token}`;
}

/** 邀请页：生成邀请注册链接（受邀者可绕过邮箱域名白名单注册）。邮箱验证管理已迁至「授权」模块。 */
export function InvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [maxUses, setMaxUses] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [disabling, setDisabling] = useState<Invite | null>(null);
  const [disableBusy, setDisableBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    void apiFetch("/api/invites")
      .then(async (r) => {
        if (!r.ok) throw new Error(`加载邀请列表失败：HTTP ${r.status}`);
        return (await r.json()) as { invites: Invite[] };
      })
      .then((data) => setInvites(data.invites))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const create = () => {
    setBusy(true);
    setError("");
    void apiFetch("/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresInDays, maxUses }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `生成失败（HTTP ${r.status}）`);
        }
        return (await r.json()) as { invite: Invite };
      })
      .then((data) => {
        setInvites((prev) => [data.invite, ...prev]);
        void navigator.clipboard
          ?.writeText(registerLink(data.invite.token))
          .then(() => setCopiedId(data.invite.id))
          .catch(() => setError("自动复制失败，请点击行内「复制链接」手动复制"));
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  const disable = () => {
    if (!disabling) return;
    setDisableBusy(true);
    setError("");
    void apiFetch(`/api/invites/${disabling.id}/disable`, { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error(`禁用失败：HTTP ${r.status}`);
        setDisabling(null);
        load();
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setDisableBusy(false));
  };

  const copy = (invite: Invite) => {
    void navigator.clipboard
      ?.writeText(registerLink(invite.token))
      .then(() => {
        setCopiedId(invite.id);
        window.setTimeout(() => setCopiedId(null), 1500);
      })
      .catch(() => setError("复制失败，请手动选择链接复制"));
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <PageHeader
        title="邀请"
        description="生成邀请注册链接：受邀者可绕过邮箱域名白名单完成注册，用于受控地增加新用户"
      />
      {error ? (
        <div className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">{error}</div>
      ) : null}

      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold">生成邀请链接</h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            有效期
            <Select
              className="w-24"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
            >
              <option value={1}>1 天</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            可用次数
            <Select
              className="w-24"
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
            >
              <option value={1}>1 次</option>
              <option value={5}>5 次</option>
              <option value={20}>20 次</option>
            </Select>
          </label>
          <Button onClick={create} disabled={busy}>
            {busy ? "生成中…" : "生成邀请链接"}
          </Button>
          <span className="text-xs text-muted-foreground">生成后自动复制到剪贴板</span>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold">我的邀请</h2>
        {loading ? (
          <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有生成过邀请链接</p>
        ) : (
          <div className="space-y-2">
            {invites.map((invite) => {
              const status = inviteStatus(invite, now);
              return (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">
                      {new Date(invite.createdAt).toLocaleString()} · {invite.usedCount}/
                      {invite.maxUses} 次已用 · 至 {new Date(invite.expiresAt).toLocaleDateString()}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground/80">
                      {registerLink(invite.token)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <Button variant="outline" size="sm" onClick={() => copy(invite)}>
                      {copiedId === invite.id ? "已复制" : "复制链接"}
                    </Button>
                    {!invite.disabled && status.label === "有效" ? (
                      <Button variant="danger" size="sm" onClick={() => setDisabling(invite)}>
                        禁用
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!disabling}
        title="禁用邀请链接"
        description={
          disabling
            ? `确定禁用该邀请链接？禁用后持有链接的人将无法再注册（已用 ${disabling.usedCount}/${disabling.maxUses} 次）。`
            : ""
        }
        destructive
        busy={disableBusy}
        onConfirm={disable}
        onCancel={() => setDisabling(null)}
      />
    </div>
  );
}
