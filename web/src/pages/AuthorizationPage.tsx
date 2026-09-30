import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { McpSection } from "../components/mcp/McpSection";
import { NotificationsAdminSection } from "../components/notifications/NotificationsAdminSection";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { type AdminUser, fetchAdminUsers, updateUserRole } from "../lib/adminUsers";
import { apiFetch, type CurrentUser, fetchMe } from "../lib/auth";
import {
  fetchSystemKeyStatus,
  importSystemKeyHistory,
  type ReEncryptReport,
  repairSystemKeys,
  rotateSystemKey,
  SYSTEM_KEY_SOURCE_LABEL,
  type SystemKeyStatus,
} from "../lib/systemKey";
import { cn } from "../lib/utils";

/**
 * 授权模块（spec 2026-09-21-auth-module-design §3.3；布局重构 2026-09-24；MCP 接入迁入 2026-09-28）：
 * 左侧固定导航 + 右侧详情（布局对齐 AgentEditorPage 的 sticky 模式）。
 * 平台授权配置（钉钉/GitHub/邮箱/用户管理，admin）分区维护；
 * 「MCP 接入」（签发个人接入令牌）全用户可用，自独立 /mcp 模块迁回本页。
 * 「应用」即生效：登录配置每请求读库即时生效，钉钉机器人消息通道保存后运行时换血，无需重启。
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

type SectionId =
  | "dingtalk"
  | "github"
  | "email"
  | "verifications"
  | "users"
  | "notifications"
  | "secretkey"
  | "mcp";

/** admin 专属分区（平台授权配置） */
const ADMIN_SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "dingtalk", label: "钉钉登录" },
  { id: "github", label: "GitHub 登录" },
  { id: "email", label: "邮箱注册" },
  { id: "verifications", label: "待验证账号" },
  { id: "users", label: "用户管理" },
  // 系统密钥生命周期（2026-09-30）：单一真源=DB，轮换自动重加密全部依赖数据
  { id: "secretkey", label: "密钥管理" },
  // 通知：通道状态+投递日志+系统公告群发（spec 2026-09-28-notification-module-design §8）
  { id: "notifications", label: "通知" },
];

/** 全用户分区：MCP 接入（签发个人接入令牌，权限=本人 web 登录口径） */
const MCP_SECTION: { id: SectionId; label: string } = { id: "mcp", label: "MCP 接入" };

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

/** 钉钉登录配置（admin） */
function DingtalkSection({
  view,
  onReload,
}: {
  view: AuthConfigsView | null;
  onReload: () => void;
}) {
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [robotCode, setRobotCode] = useState("");
  const [cardTemplateId, setCardTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loaded = view !== null;

  useEffect(() => {
    if (!view) return;
    setAppKey(view.dingtalk.appKey);
    setAppSecret("");
    setRobotCode(view.dingtalk.robotCode);
    setCardTemplateId(view.dingtalk.cardTemplateId);
  }, [view]);

  const apply = () => {
    if (!loaded) return;
    setBusy(true);
    setMsg(null);
    void apiFetch("/api/admin/auth-configs/dingtalk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey, appSecret, robotCode, cardTemplateId }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as {
          error?: string;
          robotChannelActive?: boolean;
        };
        if (!r.ok) throw new Error(data.error ?? `保存失败（HTTP ${r.status}）`);
        setMsg({
          ok: true,
          text: data.robotChannelActive
            ? "已应用：扫码登录即时生效，机器人消息通道已重载"
            : "已应用：配置已停用或机器人字段不全，消息通道未启用",
        });
        setAppSecret("");
        onReload();
      })
      .catch((reason: unknown) =>
        setMsg({ ok: false, text: reason instanceof Error ? reason.message : String(reason) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Card className="space-y-3 p-5">
      <SectionHead
        title="钉钉登录"
        description="企业自建应用（钉钉开放平台）；机器人消息通道相关字段保存后自动重载通道，无需重启"
        status={
          view?.dingtalk.appKey
            ? { label: "已启用", tone: "success" }
            : { label: "未配置", tone: "neutral" }
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">AppKey</span>
          <Input
            type="text"
            value={appKey}
            onChange={(e) => setAppKey(e.target.value)}
            placeholder="留空 = 停用钉钉登录"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">
            App Secret{view?.dingtalk.appSecretSet ? "（已设置，留空保留）" : ""}
          </span>
          <Input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={view?.dingtalk.appSecretSet ? "••••••••" : "未设置"}
            autoComplete="new-password"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">Robot Code（机器人消息通道）</span>
          <Input type="text" value={robotCode} onChange={(e) => setRobotCode(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">AI 卡片模板 ID（可选）</span>
          <Input
            type="text"
            value={cardTemplateId}
            onChange={(e) => setCardTemplateId(e.target.value)}
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
      <ApplyMsg msg={msg} />
      <Button onClick={apply} disabled={busy || !loaded}>
        {busy ? "应用中…" : "应用"}
      </Button>
    </Card>
  );
}

/** GitHub 登录配置（admin） */
function GithubSection({ view, onReload }: { view: AuthConfigsView | null; onReload: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loaded = view !== null;

  useEffect(() => {
    if (!view) return;
    setClientId(view.github.clientId);
    setClientSecret("");
  }, [view]);

  const apply = () => {
    if (!loaded) return;
    setBusy(true);
    setMsg(null);
    void apiFetch("/api/admin/auth-configs/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(data.error ?? `保存失败（HTTP ${r.status}）`);
        setMsg({ ok: true, text: "已应用：GitHub 登录/绑定即时生效" });
        setClientSecret("");
        onReload();
      })
      .catch((reason: unknown) =>
        setMsg({ ok: false, text: reason instanceof Error ? reason.message : String(reason) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Card className="space-y-3 p-5">
      <SectionHead
        title="GitHub 登录"
        description="OAuth App（github.com/settings/developers）；仅取身份（read:user），不涉及仓库权限"
        status={
          view?.github.clientId
            ? { label: "已启用", tone: "success" }
            : { label: "未配置", tone: "neutral" }
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">Client ID</span>
          <Input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="留空 = 停用 GitHub 登录"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-semibold">
            Client Secret{view?.github.clientSecretSet ? "（已设置，留空保留）" : ""}
          </span>
          <Input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={view?.github.clientSecretSet ? "••••••••" : "未设置"}
            autoComplete="new-password"
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
      <ApplyMsg msg={msg} />
      <Button onClick={apply} disabled={busy || !loaded}>
        {busy ? "应用中…" : "应用"}
      </Button>
    </Card>
  );
}

/** 邮箱注册与验证配置（admin） */
function EmailSection({ view, onReload }: { view: AuthConfigsView | null; onReload: () => void }) {
  const [domainsText, setDomainsText] = useState("");
  const [loginEnabled, setLoginEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loaded = view !== null;

  useEffect(() => {
    if (!view) return;
    setDomainsText(view.email.signupAllowedDomains.join("\n"));
    setLoginEnabled(view.email.loginEnabled);
  }, [view]);

  const apply = () => {
    if (!loaded) return;
    setBusy(true);
    setMsg(null);
    void apiFetch("/api/admin/auth-configs/email", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signupAllowedDomains: domainsText, loginEnabled }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(data.error ?? `保存失败（HTTP ${r.status}）`);
        setMsg({ ok: true, text: "已应用：注册白名单与登录开关即时生效" });
        onReload();
      })
      .catch((reason: unknown) =>
        setMsg({ ok: false, text: reason instanceof Error ? reason.message : String(reason) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Card className="space-y-3 p-5">
      <SectionHead
        title="邮箱注册与验证"
        description="域名白名单为空 = 关闭无邀请自助注册（仅邀请链接可注册）；新注册账号需管理员转交验证链接完成验证"
        status={
          view?.email.loginEnabled
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
          checked={loginEnabled}
          onCheckedChange={setLoginEnabled}
          aria-label="启用邮箱登录"
        />
        启用邮箱登录（登录页展示邮箱表单）
      </label>
      <ApplyMsg msg={msg} />
      <Button onClick={apply} disabled={busy || !loaded}>
        {busy ? "应用中…" : "应用"}
      </Button>
    </Card>
  );
}

/** 待验证账号管理（admin；自邀请页迁入） */
function VerificationsSection() {
  const [verifications, setVerifications] = useState<EmailVerification[] | null>(null);

  useEffect(() => {
    void apiFetch("/api/admin/email-verifications")
      .then(async (r) =>
        r.ok ? ((await r.json()) as { verifications: EmailVerification[] }) : null,
      )
      .then((data) => setVerifications(data?.verifications ?? null))
      .catch(() => setVerifications(null));
  }, []);

  if (!verifications) return null;
  return (
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

/** MCP 接入分区（全用户）：签发/管理个人接入令牌，把平台能力开放给外部 agent（自 /mcp 独立模块迁入） */
function McpAccessSection() {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">MCP 接入</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          用 MCP 接入令牌把平台的智能体／会话／技能／知识库开放给 zcode、Codex、Claude Code 等外部
          agent；令牌权限与你本人登录 web 时完全一致，明文只在创建时展示一次
        </p>
      </div>
      <McpSection />
    </section>
  );
}

/** 重加密报告面板：扫描/正常/重加密计数 + 无法恢复清单（轮换/导入/修复共用） */
function KeyReportPanel({
  title,
  report,
  onClose,
}: {
  title: string;
  report: ReEncryptReport;
  onClose: () => void;
}) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{title}</span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          关闭
        </Button>
      </div>
      <p className="text-[13px] text-muted-foreground">
        共扫描 {report.scanned} 个密文：{report.healthy} 个已用当前密钥可解，
        {report.healed} 个已重加密收编。
        {report.failed.length > 0
          ? `另有 ${report.failed.length} 个无法恢复，需重新录入：`
          : "无无法恢复的密文。"}
      </p>
      {report.failed.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[13px] text-destructive">
          {report.failed.map((f) => (
            <li key={`${f.kind}-${f.name}-${f.field}`}>
              {f.kind} · {f.name}（{f.field}）
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

const fmtTime = (iso: string) => (iso ? new Date(iso).toLocaleString() : "—");

/**
 * 系统密钥管理分区（2026-09-30 系统密钥生命周期）：
 * 单一真源=DB，启动 DB 优先（env 仅首次导入）；轮换一键随机/自定义，数据自动重加密；
 * 历史密钥带时间全量保留，导入历史密钥是外部漂移数据的恢复通道。
 */
function SecretKeySection() {
  const [status, setStatus] = useState<SystemKeyStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [report, setReport] = useState<{ title: string; r: ReEncryptReport } | null>(null);
  const [customSeed, setCustomSeed] = useState("");
  const [importSeed, setImportSeed] = useState("");
  const [importNote, setImportNote] = useState("");
  const [confirmRotate, setConfirmRotate] = useState<"generate" | "custom" | null>(null);
  const [confirmRepair, setConfirmRepair] = useState(false);

  const load = useCallback(() => {
    setLoadError("");
    void fetchSystemKeyStatus()
      .then(setStatus)
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const runRotate = async (mode: "generate" | "custom") => {
    setBusy(true);
    setActionError("");
    try {
      const result =
        mode === "generate"
          ? await rotateSystemKey({ generate: true })
          : await rotateSystemKey({ newValue: customSeed.trim() });
      const healed = result.report.healed + result.leftover.healed;
      setReport({
        title: `轮换完成，新密钥指纹 ${result.fingerprint}（重加密 ${healed} 个密文）`,
        r: result.leftover.healed > 0 ? result.leftover : result.report,
      });
      setCustomSeed("");
      setConfirmRotate(null);
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    setActionError("");
    try {
      const r = await importSystemKeyHistory({
        seed: importSeed.trim(),
        note: importNote.trim() || undefined,
      });
      setReport({ title: "历史密钥已导入并完成修复", r });
      setImportSeed("");
      setImportNote("");
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runRepair = async () => {
    setBusy(true);
    setActionError("");
    try {
      const r = await repairSystemKeys();
      setReport({ title: "深度修复完成", r });
      setConfirmRepair(false);
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <SectionHead
        title="系统密钥"
        description="加密模型密钥、连接器、智能体 MCP、凭证集与通知地址。密钥持久化在数据库中，改环境变量不再生效；轮换会自动用新密钥重加密全部依赖数据，历史密钥保留用于恢复。"
        status={status ? { label: SYSTEM_KEY_SOURCE_LABEL[status.source], tone: "success" } : null}
      />

      {loadError ? (
        <div className="flex items-center justify-between rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            重试
          </Button>
        </div>
      ) : null}

      {status ? (
        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">当前密钥</span>
            <span className="font-mono text-[13px] font-semibold">{status.fingerprint}</span>
            <span className="text-xs text-muted-foreground">
              {SYSTEM_KEY_SOURCE_LABEL[status.source]} · {fmtTime(status.createdAt)}
            </span>
          </div>

          {status.envKeyPresent && !status.envKeyMatches ? (
            <div className="rounded-lg bg-warning-soft p-3 text-[13px] text-warning-foreground">
              检测到环境变量 SECRET_KEY 与数据库密钥不一致：已按「数据库优先」忽略
              env。若存量数据是用该 env 密钥加密的，请在下方「导入历史密钥」填入该值完成修复。
            </div>
          ) : null}

          <div className="flex flex-col gap-2.5">
            <span className="text-[13px] font-semibold">轮换</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => setConfirmRotate("generate")}>
                一键随机生成并轮换
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-72 text-sm"
                placeholder="自定义新密钥（建议 ≥32 位随机串）"
                value={customSeed}
                onChange={(e) => setCustomSeed(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy || customSeed.trim().length < 8}
                onClick={() => setConfirmRotate("custom")}
              >
                使用自定义密钥轮换
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 border-t border-border pt-4">
            <span className="text-[13px] font-semibold">历史密钥与恢复</span>
            <p className="text-xs text-muted-foreground">
              旧平台/旧部署的数据若用其它密钥加密，把那把密钥导入为历史密钥即可自动修复；也可对已知历史密钥直接深度修复。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-72 text-sm font-mono"
                placeholder="历史密钥原文"
                value={importSeed}
                onChange={(e) => setImportSeed(e.target.value)}
              />
              <Input
                className="h-8 w-40 text-sm"
                placeholder="备注（可选）"
                value={importNote}
                onChange={(e) => setImportNote(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy || importSeed.trim().length === 0}
                onClick={() => void runImport()}
              >
                导入并修复
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmRepair(true)}
              >
                深度修复
              </Button>
            </div>
          </div>

          {status.history.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t border-border pt-4">
              <span className="text-[13px] font-semibold">密钥历史</span>
              {status.history.map((h) => (
                <div
                  key={h.fingerprint + h.createdAt}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
                >
                  <span className="font-mono">{h.fingerprint}</span>
                  <span className="text-muted-foreground">{SYSTEM_KEY_SOURCE_LABEL[h.source]}</span>
                  <span className="text-muted-foreground">{fmtTime(h.createdAt)}</span>
                  {h.retiredAt === null ? (
                    <Badge tone="success">当前</Badge>
                  ) : (
                    <span className="text-muted-foreground/70">退役于 {fmtTime(h.retiredAt)}</span>
                  )}
                  {h.note ? <span className="text-muted-foreground/80">{h.note}</span> : null}
                </div>
              ))}
            </div>
          ) : null}

          {actionError ? (
            <div
              role="alert"
              className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive"
            >
              {actionError}
            </div>
          ) : null}

          {report ? (
            <KeyReportPanel
              title={report.title}
              report={report.r}
              onClose={() => setReport(null)}
            />
          ) : null}
        </Card>
      ) : !loadError ? (
        <SectionSkeleton />
      ) : null}

      <ConfirmDialog
        open={confirmRotate !== null}
        title="轮换系统密钥？"
        description="将用新密钥重新加密全部已存密文（模型密钥/连接器/智能体 MCP/凭证集/通知地址），数据量大时耗时相应变长。建议先备份数据库；当前密钥会进入历史记录，仍可用于恢复。"
        confirmText="确认轮换"
        busy={busy}
        error={actionError}
        onConfirm={() => {
          if (confirmRotate === "generate") return void runRotate("generate");
          if (confirmRotate === "custom") return void runRotate("custom");
        }}
        onCancel={() => setConfirmRotate(null)}
      />

      <ConfirmDialog
        open={confirmRepair}
        title="执行深度修复？"
        description="以全部历史密钥为来源，把仍无法解开的密文收编到当前密钥。幂等操作，可反复执行。"
        confirmText="执行修复"
        busy={busy}
        error={actionError}
        onConfirm={() => void runRepair()}
        onCancel={() => setConfirmRepair(false)}
      />
    </section>
  );
}

/** 主组件：左侧固定导航 + 右侧详情（平台授权分区 admin 专属；MCP 接入分区全用户可用） */
export function AuthorizationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [view, setView] = useState<AuthConfigsView | null>(null);
  const [loadError, setLoadError] = useState("");

  const isAdmin = me?.role === "admin";

  useEffect(() => {
    void fetchMe().then(setMe);
  }, []);

  const allowed = [...(isAdmin ? ADMIN_SECTIONS : []), MCP_SECTION];
  const requested = searchParams.get("section") as SectionId | null;
  const active: SectionId | null =
    requested && allowed.some((s) => s.id === requested) ? requested : (allowed[0]?.id ?? null);

  const select = (id: SectionId) => {
    if (id === allowed[0]?.id) setSearchParams({}, { replace: true });
    else setSearchParams({ section: id }, { replace: true });
  };

  const load = useCallback(() => {
    setLoadError("");
    void apiFetch("/api/admin/auth-configs")
      .then(async (r) => {
        if (!r.ok) throw new Error(`加载授权配置失败：HTTP ${r.status}`);
        return (await r.json()) as AuthConfigsView;
      })
      .then(setView)
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  // admin 配置仅 admin 加载（非 admin 请求只会得到 403 噪音）
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Sticky 顶栏 */}
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card/95 px-5 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold">授权</h1>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">
            平台授权配置与 MCP 接入管理；配置修改即时生效，无需重启服务
          </p>
        </div>
      </header>

      {/* 移动端纵向排布：分区 chips 独占一行横向滚动，主内容全宽在下；lg 起恢复横排双栏 */}
      <div className="flex flex-1 flex-col lg:flex-row lg:items-start">
        {/* 移动端：横向分区 chips（sticky 于顶栏下） */}
        <nav
          aria-label="授权配置分区"
          className="no-scrollbar sticky top-16 z-10 flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card/95 px-4 py-2 backdrop-blur lg:hidden"
        >
          {allowed.map((s) => (
            <button
              key={s.id}
              type="button"
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs transition-colors",
                active === s.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground hover:opacity-80",
              )}
              onClick={() => select(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* 桌面：左固定导航（sticky；高度保持自然高度，self-stretch 拉满会使 sticky 失效） */}
        <nav
          aria-label="授权配置分区"
          className="sticky top-16 hidden w-52 shrink-0 flex-col gap-1 self-start border-r border-border bg-card/60 p-3 lg:flex"
        >
          {allowed.map((s) => (
            <button
              key={s.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                active === s.id
                  ? "bg-primary-soft font-semibold text-primary"
                  : "text-foreground hover:bg-muted",
              )}
              onClick={() => select(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* 右侧详情 */}
        <main className="min-w-0 flex-1 space-y-5 p-5 pb-16 lg:p-6">
          {active === "mcp" ? (
            <McpAccessSection />
          ) : !isAdmin ? (
            <p className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
              授权配置仅管理员可见
            </p>
          ) : (
            <>
              {loadError ? (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
                  <span>{loadError}</span>
                  <Button variant="outline" size="sm" onClick={load}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    重试
                  </Button>
                </div>
              ) : !view ? (
                <>
                  <SectionSkeleton />
                  <SectionSkeleton />
                </>
              ) : null}

              {active === "dingtalk" ? <DingtalkSection view={view} onReload={load} /> : null}
              {active === "github" ? <GithubSection view={view} onReload={load} /> : null}
              {active === "email" ? <EmailSection view={view} onReload={load} /> : null}
              {active === "verifications" ? <VerificationsSection /> : null}
              {active === "users" ? <UserManagementSection /> : null}
              {active === "secretkey" ? <SecretKeySection /> : null}
              {active === "notifications" ? <NotificationsAdminSection /> : null}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
