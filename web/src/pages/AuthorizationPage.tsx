import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { type AdminUser, fetchAdminUsers, updateUserRole } from "../lib/adminUsers";
import { apiFetch, type CurrentUser, fetchMe } from "../lib/auth";

/**
 * 授权模块（admin，spec 2026-09-21-auth-module-design §3.3）：
 * 钉钉 / GitHub / 邮箱注册与验证 的配置统一在此维护。
 * 「应用」即生效：登录配置每请求读库即时生效；钉钉机器人消息通道保存后运行时换血，无需重启。
 * 加载完成前表单不渲染、应用按钮禁用——防止把空配置 PUT 上去（清空 AppKey = 停用钉钉登录）。
 */

interface AuthConfigsView {
  dingtalk: {
    appKey: string;
    appSecretSet: boolean;
    robotCode: string;
    cardTemplateId: string;
    callbackUrl: string;
  };
  github: { clientId: string; clientSecretSet: boolean; callbackUrl: string };
  email: { signupAllowedDomains: string[]; loginEnabled: boolean };
}

interface EmailVerification {
  userId: string;
  email: string;
  verified: boolean;
  expiresAt: string | null;
  expired: boolean;
  verifyPath: string | null;
}

const PROVIDER_LABEL: Record<string, string> = {
  email: "邮箱",
  dingtalk: "钉钉",
  github: "GitHub",
};

/** 保存结果横幅：成功/失败统一软底色 + 语义色文字 */
function ApplyMsg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <div
      className={`rounded-lg p-2.5 text-sm ${
        msg.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"
      }`}
    >
      {msg.text}
    </div>
  );
}

/** 分区卡头：标题 + 状态徽标（与设计稿 P24 一致） */
function SectionHead({
  title,
  description,
  status,
}: {
  title: string;
  description: string;
  status: { label: string; tone: "success" | "neutral" } | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** 用户管理区块（admin，spec 2026-09-21-user-management-design §2.4）：
 *  全量用户 + 管理员授予/取消。自己不可变更自己；白名单用户/最后一位 admin 由后端 409 兜底提示。 */
function UserManagementSection() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("");
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [confirm, setConfirm] = useState<{ user: AdminUser; toRole: "admin" | "user" } | null>(
    null,
  );
  const [confirmError, setConfirmError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError("");
    fetchAdminUsers()
      .then(setUsers)
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  useEffect(() => {
    load();
    void fetchMe().then(setMe);
  }, [load]);

  if (users === null && !loadError) return null; // admin 接口不可用（非 admin）时整块不渲染

  const adminCount = users?.filter((u) => u.role === "admin").length ?? 0;
  const keyword = filter.trim().toLowerCase();
  const filtered =
    users?.filter(
      (u) =>
        !keyword ||
        u.name.toLowerCase().includes(keyword) ||
        u.identities.some((i) => i.externalId.toLowerCase().includes(keyword)),
    ) ?? [];

  const doChange = () => {
    if (!confirm) return;
    setBusy(true);
    setConfirmError("");
    updateUserRole(confirm.user.id, confirm.toRole)
      .then((updated) => {
        setUsers((prev) => prev?.map((u) => (u.id === updated.id ? updated : u)) ?? prev);
        setConfirm(null);
      })
      .catch((reason: unknown) =>
        setConfirmError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Card className="space-y-3 p-5">
      <SectionHead
        title="用户管理"
        description="全部注册用户与管理员授予/取消。变更下一个请求即生效；不能变更自己的角色，系统至少保留一位管理员"
        status={null}
      />
      {loadError ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive-soft p-2.5 text-sm text-destructive">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <Input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按名称或邮箱过滤"
          />
          <div className="space-y-2">
            {filtered.map((u) => {
              const isSelf = me?.id === u.id;
              const isLastAdmin = u.role === "admin" && adminCount <= 1;
              const toRole = u.role === "admin" ? "user" : "admin";
              const disabled = isSelf || isLastAdmin;
              const hint = isSelf
                ? "不能变更自己的角色"
                : isLastAdmin
                  ? "至少保留一位管理员"
                  : undefined;
              return (
                <div
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{u.name}</span>
                      {u.role === "admin" ? <Badge tone="primary">管理员</Badge> : null}
                      {isSelf ? <Badge tone="neutral">我</Badge> : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {u.identities.map((i) => (
                        <Badge key={`${i.provider}:${i.externalId}`} tone="neutral">
                          {PROVIDER_LABEL[i.provider] ?? i.provider}
                          {"： "}
                          <span className="font-mono">{i.externalId}</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className="text-[11px] text-muted-foreground"
                      title={new Date(u.createdAt).toLocaleString()}
                    >
                      {new Date(u.createdAt).toLocaleDateString()}
                    </span>
                    <span title={hint}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
                          setConfirmError("");
                          setConfirm({ user: u, toRole });
                        }}
                      >
                        {toRole === "admin" ? "设为管理员" : "取消管理员"}
                      </Button>
                    </span>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">无匹配用户</p>
            ) : null}
          </div>
        </>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.toRole === "admin" ? "设为管理员" : "取消管理员"}
        description={
          confirm
            ? confirm.toRole === "admin"
              ? `确定将「${confirm.user.name}」设为管理员？对方将立即获得全部管理权限。`
              : `确定取消「${confirm.user.name}」的管理员权限？下一个请求起即生效。`
            : ""
        }
        destructive={confirm?.toRole === "user"}
        busy={busy}
        error={confirmError}
        onConfirm={doChange}
        onCancel={() => {
          setConfirm(null);
          setConfirmError("");
        }}
      />
    </Card>
  );
}

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? "已复制" : label}
    </Button>
  );
}

/** 分区加载骨架（配置请求返回前不渲染表单） */
function SectionSkeleton() {
  return (
    <Card className="space-y-3 p-5" aria-hidden="true">
      <div className="h-5 w-32 animate-pulse rounded bg-muted" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-9 animate-pulse rounded-lg bg-muted" />
        <div className="h-9 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="h-9 w-24 animate-pulse rounded-lg bg-muted" />
    </Card>
  );
}

export function AuthorizationPage() {
  const [view, setView] = useState<AuthConfigsView | null>(null);
  const [loadError, setLoadError] = useState("");

  // 钉钉表单
  const [dtAppKey, setDtAppKey] = useState("");
  const [dtAppSecret, setDtAppSecret] = useState("");
  const [dtRobotCode, setDtRobotCode] = useState("");
  const [dtCardTemplateId, setDtCardTemplateId] = useState("");
  const [dtBusy, setDtBusy] = useState(false);
  const [dtMsg, setDtMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // GitHub 表单
  const [ghClientId, setGhClientId] = useState("");
  const [ghClientSecret, setGhClientSecret] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghMsg, setGhMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 邮箱表单
  const [domainsText, setDomainsText] = useState("");
  const [emailLoginEnabled, setEmailLoginEnabled] = useState(true);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 待验证账号管理（自邀请页迁入）
  const [verifications, setVerifications] = useState<EmailVerification[] | null>(null);

  const loaded = view !== null;

  const load = useCallback(() => {
    setLoadError("");
    void apiFetch("/api/admin/auth-configs")
      .then(async (r) => {
        if (!r.ok) throw new Error(`加载授权配置失败：HTTP ${r.status}`);
        return (await r.json()) as AuthConfigsView;
      })
      .then((data) => {
        setView(data);
        setDtAppKey(data.dingtalk.appKey);
        setDtAppSecret("");
        setDtRobotCode(data.dingtalk.robotCode);
        setDtCardTemplateId(data.dingtalk.cardTemplateId);
        setGhClientId(data.github.clientId);
        setGhClientSecret("");
        setDomainsText(data.email.signupAllowedDomains.join("\n"));
        setEmailLoginEnabled(data.email.loginEnabled);
      })
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  useEffect(() => {
    load();
    // 邮箱验证管理以 admin 接口可用性判定渲染（同邀请页原实现）
    void apiFetch("/api/admin/email-verifications")
      .then(async (r) =>
        r.ok ? ((await r.json()) as { verifications: EmailVerification[] }) : null,
      )
      .then((data) => setVerifications(data?.verifications ?? null))
      .catch(() => setVerifications(null));
  }, [load]);

  const applyDingtalk = () => {
    if (!loaded) return;
    setDtBusy(true);
    setDtMsg(null);
    void apiFetch("/api/admin/auth-configs/dingtalk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: dtAppKey,
        appSecret: dtAppSecret,
        robotCode: dtRobotCode,
        cardTemplateId: dtCardTemplateId,
      }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as {
          error?: string;
          robotChannelActive?: boolean;
        };
        if (!r.ok) throw new Error(data.error ?? `保存失败（HTTP ${r.status}）`);
        setDtMsg({
          ok: true,
          text: data.robotChannelActive
            ? "已应用：扫码登录即时生效，机器人消息通道已重载"
            : "已应用：配置已停用或机器人字段不全，消息通道未启用",
        });
        setDtAppSecret("");
      })
      .catch((reason: unknown) =>
        setDtMsg({ ok: false, text: reason instanceof Error ? reason.message : String(reason) }),
      )
      .finally(() => setDtBusy(false));
  };

  const applyGithub = () => {
    if (!loaded) return;
    setGhBusy(true);
    setGhMsg(null);
    void apiFetch("/api/admin/auth-configs/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: ghClientId, clientSecret: ghClientSecret }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(data.error ?? `保存失败（HTTP ${r.status}）`);
        setGhMsg({ ok: true, text: "已应用：GitHub 登录/绑定即时生效" });
        setGhClientSecret("");
      })
      .catch((reason: unknown) =>
        setGhMsg({ ok: false, text: reason instanceof Error ? reason.message : String(reason) }),
      )
      .finally(() => setGhBusy(false));
  };

  const applyEmail = () => {
    if (!loaded) return;
    setEmailBusy(true);
    setEmailMsg(null);
    void apiFetch("/api/admin/auth-configs/email", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signupAllowedDomains: domainsText,
        loginEnabled: emailLoginEnabled,
      }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(data.error ?? `保存失败（HTTP ${r.status}）`);
        setEmailMsg({ ok: true, text: "已应用：注册白名单与登录开关即时生效" });
      })
      .catch((reason: unknown) =>
        setEmailMsg({ ok: false, text: reason instanceof Error ? reason.message : String(reason) }),
      )
      .finally(() => setEmailBusy(false));
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <PageHeader
        title="授权"
        description="钉钉 / GitHub / 邮箱注册的授权配置与用户管理。修改后点击「应用」立即生效，无需重启服务"
      />
      {loadError ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </Button>
        </div>
      ) : !loaded ? (
        <>
          <SectionSkeleton />
          <SectionSkeleton />
        </>
      ) : null}

      {/* 钉钉登录 */}
      {loaded ? (
        <Card className="space-y-3 p-5">
          <SectionHead
            title="钉钉登录"
            description="企业自建应用（钉钉开放平台）；机器人消息通道相关字段保存后自动重载通道，无需重启"
            status={
              view.dingtalk.appKey ? { label: "已启用", tone: "success" } : { label: "未配置", tone: "neutral" }
            }
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-semibold">AppKey</span>
              <Input
                type="text"
                value={dtAppKey}
                onChange={(e) => setDtAppKey(e.target.value)}
                placeholder="留空 = 停用钉钉登录"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-semibold">
                App Secret{view.dingtalk.appSecretSet ? "（已设置，留空保留）" : ""}
              </span>
              <Input
                type="password"
                value={dtAppSecret}
                onChange={(e) => setDtAppSecret(e.target.value)}
                placeholder={view.dingtalk.appSecretSet ? "••••••••" : "未设置"}
                autoComplete="new-password"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-semibold">Robot Code（机器人消息通道）</span>
              <Input
                type="text"
                value={dtRobotCode}
                onChange={(e) => setDtRobotCode(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-semibold">AI 卡片模板 ID（可选）</span>
              <Input
                type="text"
                value={dtCardTemplateId}
                onChange={(e) => setDtCardTemplateId(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>回调地址（须与钉钉开放平台登记一致）：</span>
            <code className="rounded bg-muted px-1.5 py-0.5">{view.dingtalk.callbackUrl}</code>
            <CopyButton text={view.dingtalk.callbackUrl} />
          </div>
          <ApplyMsg msg={dtMsg} />
          <Button onClick={applyDingtalk} disabled={dtBusy || !loaded}>
            {dtBusy ? "应用中…" : "应用"}
          </Button>
        </Card>
      ) : null}

      {/* GitHub 登录 */}
      {loaded ? (
        <Card className="space-y-3 p-5">
          <SectionHead
            title="GitHub 登录"
            description="OAuth App（github.com/settings/developers）；仅取身份（read:user），不涉及仓库权限"
            status={
              view.github.clientId
                ? { label: "已启用", tone: "success" }
                : { label: "未配置", tone: "neutral" }
            }
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-semibold">Client ID</span>
              <Input
                type="text"
                value={ghClientId}
                onChange={(e) => setGhClientId(e.target.value)}
                placeholder="留空 = 停用 GitHub 登录"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-semibold">
                Client Secret{view.github.clientSecretSet ? "（已设置，留空保留）" : ""}
              </span>
              <Input
                type="password"
                value={ghClientSecret}
                onChange={(e) => setGhClientSecret(e.target.value)}
                placeholder={view.github.clientSecretSet ? "••••••••" : "未设置"}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>回调地址（须与 OAuth App 登记一致）：</span>
            <code className="rounded bg-muted px-1.5 py-0.5">{view.github.callbackUrl}</code>
            <CopyButton text={view.github.callbackUrl} />
          </div>
          <ApplyMsg msg={ghMsg} />
          <Button onClick={applyGithub} disabled={ghBusy || !loaded}>
            {ghBusy ? "应用中…" : "应用"}
          </Button>
        </Card>
      ) : null}

      {/* 邮箱注册与验证 */}
      {loaded ? (
        <Card className="space-y-3 p-5">
          <SectionHead
            title="邮箱注册与验证"
            description="域名白名单为空 = 关闭无邀请自助注册（仅邀请链接可注册）；新注册账号需管理员转交验证链接完成验证"
            status={
              view.email.loginEnabled
                ? { label: "已启用", tone: "success" }
                : { label: "已停用", tone: "neutral" }
            }
          />
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-[13px] font-semibold">
              邮箱域名白名单（每行一个，支持 .example.com 通配子域）
            </span>
            <Textarea
              rows={3}
              value={domainsText}
              onChange={(e) => setDomainsText(e.target.value)}
              placeholder={"example.com\n.corp.cn"}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={emailLoginEnabled}
              onCheckedChange={setEmailLoginEnabled}
              aria-label="启用邮箱登录"
            />
            启用邮箱登录（登录页展示邮箱表单）
          </label>
          <ApplyMsg msg={emailMsg} />
          <Button onClick={applyEmail} disabled={emailBusy || !loaded}>
            {emailBusy ? "应用中…" : "应用"}
          </Button>
        </Card>
      ) : null}

      {/* 待验证账号管理（自邀请页迁入） */}
      {verifications ? (
        <Card className="space-y-3 p-5">
          <SectionHead
            title="待验证账号"
            description="邮箱注册账号需凭验证链接完成验证；把链接发给对应用户，对方打开即完成验证并自动登录"
            status={null}
          />
          {verifications.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无邮箱验证记录</p>
          ) : (
            <div className="space-y-2">
              {verifications.map((v) => {
                const status = v.verified
                  ? { label: "已验证", tone: "success" as const }
                  : v.expired
                    ? { label: "已过期", tone: "neutral" as const }
                    : { label: "待验证", tone: "warning" as const };
                return (
                  <div
                    key={v.userId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm">{v.email}</div>
                      {v.expiresAt ? (
                        <div className="text-xs text-muted-foreground">
                          验证有效期至 {new Date(v.expiresAt).toLocaleString()}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {status.label === "待验证" && v.verifyPath ? (
                        <CopyButton
                          text={`${window.location.origin}${v.verifyPath}`}
                          label="复制验证链接"
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ) : null}

      {/* 用户管理（admin；spec 2026-09-21-user-management-design §2.4） */}
      <UserManagementSection />
    </div>
  );
}
