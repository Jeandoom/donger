import {
  AppWindow,
  Blocks,
  Bot,
  KeyRound,
  LogOut,
  Megaphone,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Repeat,
  ScrollText,
  Sparkles,
  UserRound,
  Workflow,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch, apiFetchRetry, clearToken, getToken } from "../../lib/auth";
import { cn } from "../../lib/utils";
import { CredentialIcon } from "../icons/CredentialIcon";
import { InviteIcon } from "../icons/InviteIcon";
import { KbIcon } from "../icons/KbIcon";
import { ModelIcon } from "../icons/ModelIcon";
import { ConfirmDialog } from "../ui/confirm-dialog";

/** 导航图标：lucide 或 Penpot 素材组件，统一 size/className 契约 */
type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

interface LeafItem {
  to: string;
  label: string;
  icon: NavIcon;
  end?: boolean;
}

// 主导航（模块）
const mainEntries: LeafItem[] = [
  { to: "/", label: "对话", icon: MessageSquare, end: true },
  // 智能体会话已并入对话模块（/），智能体入口收敛为管理页叶节点
  { to: "/agents", label: "智能体", icon: Bot },
  // 应用模块：平台内开发/托管/运行的个人应用（app runtime）
  { to: "/apps", label: "应用", icon: AppWindow },
  { to: "/kb", label: "知识库", icon: KbIcon },
  { to: "/workflows", label: "工作流", icon: Workflow },
  { to: "/triggers", label: "触发器", icon: Zap },
  { to: "/loops", label: "LOOPs", icon: Repeat },
  { to: "/skills", label: "技能", icon: Sparkles },
  { to: "/connectors", label: "连接器", icon: Plug },
];

// 配置类模块沉底展示（个人并入底部用户栏，不再占导航位；审计/MCP 接入自主导航迁入）
const bottomEntries: LeafItem[] = [
  { to: "/models", label: "模型", icon: ModelIcon },
  { to: "/credentials", label: "凭证", icon: CredentialIcon },
  // MCP 接入：签发个人令牌把平台能力开放给外部 agent，与凭证同属接入凭证类
  { to: "/mcp", label: "MCP 接入", icon: Blocks },
  { to: "/invites", label: "邀请", icon: InviteIcon },
  { to: "/feedback", label: "反馈", icon: Megaphone },
  // 审计单页：会话栏内置「只看LLM」开关切换历史会话/LLM 观测两种详情形态
  { to: "/audit", label: "审计", icon: ScrollText },
];

// 管理员专属沉底项：授权（三方登录配置 Web 化）/ 代理（出站请求代理）
const adminBottomEntries: LeafItem[] = [
  { to: "/authorization", label: "授权", icon: KeyRound },
  { to: "/proxy", label: "代理", icon: Network },
];

interface UserInfo {
  id: string;
  name: string;
  avatar?: string;
  role: string;
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
    isActive
      ? "bg-sidebar-active font-semibold text-white"
      : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-white",
  );

const iconLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "group relative flex h-9 w-full items-center justify-center rounded-lg transition-colors",
    isActive
      ? "bg-sidebar-active text-white"
      : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-white",
  );

/** 折叠态 hover 浮出右侧的名称提示（纯 CSS，不拦截指针） */
const tipClass =
  "pointer-events-none absolute left-full top-1/2 z-20 ml-1.5 -translate-y-1/2 whitespace-nowrap rounded-md bg-sidebar-hover px-2 py-1 text-xs font-medium text-white opacity-0 transition-opacity duration-100 group-hover:opacity-100";

/** 折叠态浮层容器：padding 留出与 icon 的连桥，避免跨间隙时 hover 丢失 */
const flyoutClass =
  "pointer-events-none absolute left-full top-0 z-30 pl-1.5 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100";

export function NavigationSidebar({
  className,
  onNavigate,
  collapsible = false,
}: {
  className?: string;
  onNavigate?: () => void;
  /** 桌面端传 true 启用折叠；移动端抽屉不传，永远展开 */
  collapsible?: boolean;
}) {
  const navigate = useNavigate();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [userError, setUserError] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false;
    try {
      return localStorage.getItem("donger_nav_collapsed") === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("donger_nav_collapsed", next ? "1" : "0");
      } catch {
        // 忽略
      }
      return next;
    });
  };

  const loadUser = useCallback(async () => {
    setUserError(false);
    try {
      const data = (await apiFetchRetry("/api/auth/me").then((r) => (r.ok ? r.json() : null))) as {
        user?: UserInfo;
      } | null;
      if (data?.user) setUser(data.user);
      else setUserError(true);
    } catch {
      setUserError(true);
    }
  }, []);

  useEffect(() => {
    if (getToken()) void loadUser();
  }, [loadUser]);

  const handleLogout = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    clearToken();
    navigate("/login");
  };

  const avatar = (size: number) => (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-cyan-400 text-[11px] font-bold text-sidebar"
      style={{ height: size, width: size }}
    >
      {user?.avatar ? (
        <img src={user.avatar} alt="" className="h-full w-full rounded-full" />
      ) : (
        user?.name.charAt(0)
      )}
    </div>
  );

  const logoutButton = (iconSize: number) => (
    <button
      type="button"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:text-white"
      onClick={() => setLogoutConfirmOpen(true)}
      title="退出登录"
      aria-label="退出登录"
    >
      <LogOut size={iconSize} />
    </button>
  );

  const renderLeaf = (e: LeafItem, collapsedMode: boolean) => {
    const Icon = e.icon;
    if (collapsedMode) {
      return (
        <NavLink
          key={e.to}
          to={e.to}
          end={e.end}
          onClick={onNavigate}
          aria-label={e.label}
          className={iconLinkClass}
        >
          <Icon size={18} className="shrink-0" />
          <span className={tipClass}>{e.label}</span>
        </NavLink>
      );
    }
    return (
      <NavLink key={e.to} to={e.to} end={e.end} onClick={onNavigate} className={linkClass}>
        <Icon size={18} className="shrink-0" />
        <span className="truncate">{e.label}</span>
      </NavLink>
    );
  };

  return (
    <nav
      className={cn(
        "flex h-full flex-col bg-sidebar px-3 pb-4 pt-5 transition-[width] duration-200 ease-in-out",
        collapsed ? "w-16" : "w-60",
        className,
      )}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-3 pb-4">
          <img src="/pwa-icon.svg" alt="donger logo" className="h-7 w-7 rounded-lg" />
          {collapsible && (
            <button
              type="button"
              onClick={toggleCollapsed}
              title="展开侧边栏"
              aria-label="展开侧边栏"
              className="flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-hover hover:text-white"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2.5 px-2 pb-4">
          <img src="/pwa-icon.svg" alt="donger logo" className="h-7 w-7 rounded-lg" />
          <span className="text-[17px] font-bold text-white">donger</span>
          {collapsible && (
            <button
              type="button"
              onClick={toggleCollapsed}
              title="折叠侧边栏"
              aria-label="折叠侧边栏"
              className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-hover hover:text-white"
            >
              <PanelLeftClose size={16} />
            </button>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {mainEntries.map((e) => renderLeaf(e, collapsed))}
      </div>

      {/* 原设置子模块：一级化后沉底；授权/代理仅管理员可见 */}
      <div className="mt-2 shrink-0 border-t border-white/10 pt-2">
        <div className="flex flex-col gap-0.5">
          {bottomEntries.map((e) => renderLeaf(e, collapsed))}
          {user?.role === "admin" ? adminBottomEntries.map((e) => renderLeaf(e, collapsed)) : null}
        </div>
      </div>

      {user ? (
        collapsed ? (
          <div className="group relative mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => navigate("/profile")}
              title="个人设置"
              aria-label="个人设置"
            >
              {avatar(26)}
            </button>
            <div className={cn(flyoutClass, "top-auto bottom-0")}>
              <div className="w-44 rounded-xl border border-border bg-card p-2 shadow-lg">
                <div className="flex items-center gap-2 px-1 pb-1.5">
                  {avatar(20)}
                  <span className="max-w-[120px] truncate text-xs font-medium text-foreground">
                    {user.name}
                  </span>
                </div>
                <NavLink
                  to="/profile"
                  className={({ isActive }) =>
                    cn(
                      "flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-[13px] text-foreground transition-colors hover:bg-muted",
                      isActive && "bg-primary-soft font-semibold text-primary",
                    )
                  }
                >
                  <UserRound size={14} />
                  个人设置
                </NavLink>
                <button
                  type="button"
                  onClick={() => setLogoutConfirmOpen(true)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-[13px] text-destructive transition-colors hover:bg-destructive-soft"
                >
                  <LogOut size={14} />
                  退出登录
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-between rounded-lg bg-sidebar-hover px-2.5 py-2">
            <button
              type="button"
              onClick={() => navigate("/profile")}
              className="flex min-w-0 items-center gap-2.5 rounded-md text-left"
              title="个人设置"
              aria-label="个人设置"
            >
              {avatar(26)}
              <span className="max-w-[110px] truncate text-xs font-medium text-white">
                {user.name}
              </span>
            </button>
            {logoutButton(14)}
          </div>
        )
      ) : userError ? (
        collapsed ? (
          <button
            type="button"
            className="mt-3 flex justify-center"
            onClick={() => void loadUser()}
            title="用户信息加载失败，点击重试"
            aria-label="用户信息加载失败，点击重试"
          >
            {avatar(26)}
          </button>
        ) : (
          <button
            type="button"
            className="mt-3 w-full rounded-lg bg-sidebar-hover px-2.5 py-2 text-left text-xs text-sidebar-foreground hover:text-white"
            onClick={() => void loadUser()}
          >
            用户信息加载失败，点击重试
          </button>
        )
      ) : collapsed ? (
        <div className="mt-3 flex justify-center" title="未登录">
          {avatar(26)}
        </div>
      ) : (
        <div className="px-2.5 py-2 text-xs text-sidebar-foreground">未登录</div>
      )}

      <ConfirmDialog
        open={logoutConfirmOpen}
        title="退出登录"
        description="退出后将返回登录页，确定要退出当前账号吗？"
        confirmText="退出"
        destructive
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          void handleLogout();
        }}
        onCancel={() => setLogoutConfirmOpen(false)}
      />
    </nav>
  );
}
