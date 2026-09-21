import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
import { type AdminUser, fetchAdminUsers, updateUserRole } from "../lib/adminUsers";
import { apiFetch, type CurrentUser, fetchMe } from "../lib/auth";

/**
 * 授权模块（admin，spec 2026-09-21-auth-module-design §3.3）：
 * 钉钉 / GitHub / 邮箱注册与验证 的配置统一在此维护。
 * 「应用」即生效：登录配置每请求读库即时生效；钉钉机器人消息通道保存后运行时换血，无需重启。
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

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary";

const PROVIDER_LABEL: Record<string, string> = {
  email: "邮箱",
  dingtalk: "钉钉",
  github: "GitHub",
};

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
    <section className="space-y-3 rounded-lg border bg-background p-5">
      <h2 className="font-medium">用户管理</h2>
      <p className="text-xs text-muted-foreground">
        全部注册用户与管理员授予/取消。变更下一个请求即生效；不能变更自己的角色，系统至少保留一位管理员
      </p>
      {loadError ? (
        <div className="flex items-center justify-between gap-2 rounded bg-destructive-soft p-2.5 text-sm text-destructive">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按名称或邮箱过滤"
            className={inputClass}
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
                  className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{u.name}</span>
                      {u.role === "admin" ? (
                        <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          管理员
                        </span>
                      ) : null}
                      {isSelf ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          我
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {u.identities.map((i) => (
                        <span
                          key={`${i.provider}:${i.externalId}`}
                          className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {PROVIDER_LABEL[i.provider] ?? i.provider}
                          {i.provider === "email" ? "： " : "： "}
                          <span className="font-mono">{i.externalId}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className="text-[10px] text-muted-foreground"
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
    </section>
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
        <div className="rounded bg-destructive-soft p-3 text-sm text-destructive">{loadError}</div>
      ) : null}

      {/* 钉钉登录 */}
      <section className="space-y-3 rounded-lg border bg-background p-5">
        <h2 className="font-medium">钉钉登录</h2>
        <p className="text-xs text-muted-foreground">
          企业自建应用（钉钉开放平台）；机器人消息通道相关字段保存后自动重载通道，无需重启
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>AppKey</span>
            <input
              type="text"
              value={dtAppKey}
              onChange={(e) => setDtAppKey(e.target.value)}
              placeholder="留空 = 停用钉钉登录"
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>App Secret{view?.dingtalk.appSecretSet ? "（已设置，留空保留）" : ""}</span>
            <input
              type="password"
              value={dtAppSecret}
              onChange={(e) => setDtAppSecret(e.target.value)}
              placeholder={view?.dingtalk.appSecretSet ? "••••••••" : "未设置"}
              autoComplete="new-password"
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>Robot Code（机器人消息通道）</span>
            <input
              type="text"
              value={dtRobotCode}
              onChange={(e) => setDtRobotCode(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>AI 卡片模板 ID（可选）</span>
            <input
              type="text"
              value={dtCardTemplateId}
              onChange={(e) => setDtCardTemplateId(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        {view ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>回调地址（须与钉钉开放平台登记一致）：</span>
            <code className="rounded bg-muted px-1.5 py-0.5">{view.dingtalk.callbackUrl}</code>
            <CopyButton text={view.dingtalk.callbackUrl} />
          </div>
        ) : null}
        {dtMsg ? (
          <div
            className={`rounded p-2.5 text-sm ${dtMsg.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"}`}
          >
            {dtMsg.text}
          </div>
        ) : null}
        <Button onClick={applyDingtalk} disabled={dtBusy}>
          {dtBusy ? "应用中…" : "应用"}
        </Button>
      </section>

      {/* GitHub 登录 */}
      <section className="space-y-3 rounded-lg border bg-background p-5">
        <h2 className="font-medium">GitHub 登录</h2>
        <p className="text-xs text-muted-foreground">
          OAuth App（github.com/settings/developers）；仅取身份（read:user），不涉及仓库权限
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Client ID</span>
            <input
              type="text"
              value={ghClientId}
              onChange={(e) => setGhClientId(e.target.value)}
              placeholder="留空 = 停用 GitHub 登录"
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>Client Secret{view?.github.clientSecretSet ? "（已设置，留空保留）" : ""}</span>
            <input
              type="password"
              value={ghClientSecret}
              onChange={(e) => setGhClientSecret(e.target.value)}
              placeholder={view?.github.clientSecretSet ? "••••••••" : "未设置"}
              autoComplete="new-password"
              className={inputClass}
            />
          </label>
        </div>
        {view ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>回调地址（须与 OAuth App 登记一致）：</span>
            <code className="rounded bg-muted px-1.5 py-0.5">{view.github.callbackUrl}</code>
            <CopyButton text={view.github.callbackUrl} />
          </div>
        ) : null}
        {ghMsg ? (
          <div
            className={`rounded p-2.5 text-sm ${ghMsg.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"}`}
          >
            {ghMsg.text}
          </div>
        ) : null}
        <Button onClick={applyGithub} disabled={ghBusy}>
          {ghBusy ? "应用中…" : "应用"}
        </Button>
      </section>

      {/* 邮箱注册与验证 */}
      <section className="space-y-3 rounded-lg border bg-background p-5">
        <h2 className="font-medium">邮箱注册与验证</h2>
        <p className="text-xs text-muted-foreground">
          域名白名单为空 =
          关闭无邀请自助注册（仅邀请链接可注册）；新注册账号需管理员转交验证链接完成验证
        </p>
        <label className="block space-y-1 text-sm">
          <span>邮箱域名白名单（每行一个，支持 .example.com 通配子域）</span>
          <textarea
            rows={3}
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            placeholder={"example.com\n.corp.cn"}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={emailLoginEnabled}
            onChange={(e) => setEmailLoginEnabled(e.target.checked)}
          />
          启用邮箱登录（登录页展示邮箱表单）
        </label>
        {emailMsg ? (
          <div
            className={`rounded p-2.5 text-sm ${emailMsg.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"}`}
          >
            {emailMsg.text}
          </div>
        ) : null}
        <Button onClick={applyEmail} disabled={emailBusy}>
          {emailBusy ? "应用中…" : "应用"}
        </Button>
      </section>

      {/* 待验证账号管理（自邀请页迁入） */}
      {verifications ? (
        <section className="space-y-3 rounded-lg border bg-background p-5">
          <h2 className="font-medium">待验证账号</h2>
          <p className="text-xs text-muted-foreground">
            邮箱注册账号需凭验证链接完成验证；把链接发给对应用户，对方打开即完成验证并自动登录
          </p>
          {verifications.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无邮箱验证记录</p>
          ) : (
            <div className="space-y-2">
              {verifications.map((v) => {
                const status = v.verified
                  ? { label: "已验证", cls: "text-success" }
                  : v.expired
                    ? { label: "已过期", cls: "text-muted-foreground" }
                    : { label: "待验证", cls: "text-amber-600" };
                return (
                  <div
                    key={v.userId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2"
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
                      <span className={`text-xs font-medium ${status.cls}`}>{status.label}</span>
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
        </section>
      ) : null}

      {/* 用户管理（admin；spec 2026-09-21-user-management-design §2.4） */}
      <UserManagementSection />
    </div>
  );
}
