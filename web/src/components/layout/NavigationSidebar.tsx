import type { LucideIcon } from "lucide-react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Repeat,
  ScrollText,
  Settings,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { apiFetch, apiFetchRetry, clearToken, getToken } from "../../lib/auth";
import { cn } from "../../lib/utils";

interface LeafItem {
  to: string;
  label: string;
  /** 顶层导航项必填；父项子菜单里的子项不展示图标 */
  icon?: LucideIcon;
  end?: boolean;
}
interface ParentItem {
  key: "agents" | "workflows" | "settings" | "observation";
  label: string;
  icon: LucideIcon;
  /** 命中即视为该父项激活（用于自动展开） */
  match: string[];
  children: LeafItem[];
}
type NavEntry = LeafItem | ParentItem;

const entries: NavEntry[] = [
  { to: "/", label: "对话", icon: MessageSquare, end: true },
  {
    key: "agents",
    label: "智能体",
    icon: Bot,
    match: ["/agents", "/agent-sessions"],
    children: [
      { to: "/agents", label: "智能体管理" },
      { to: "/agent-sessions", label: "智能体会话" },
    ],
  },
  {
    key: "workflows",
    label: "工作流",
    icon: Workflow,
    match: ["/workflows", "/triggers"],
    children: [
      { to: "/workflows", label: "工作流管理" },
      { to: "/triggers", label: "触发器管理" },
    ],
  },
  { to: "/loops", label: "LOOPs", icon: Repeat },
  { to: "/skills", label: "技能", icon: Sparkles },
  { to: "/connectors", label: "连接器", icon: Plug },
  {
    key: "observation",
    label: "审计",
    icon: ScrollText,
    match: ["/audit"],
    children: [
      { to: "/audit/history", label: "历史会话" },
      { to: "/audit/llm", label: "LLM 观测" },
    ],
  },
  {
    key: "settings",
    label: "设置",
    icon: Settings,
    match: ["/settings"],
    children: [
      { to: "/settings/profile", label: "个人" },
      { to: "/settings/models", label: "模型" },
      { to: "/settings/credentials", label: "凭证" },
      { to: "/settings/invites", label: "邀请" },
    ],
  },
];

function isParent(e: NavEntry): e is ParentItem {
  return (e as ParentItem).children !== undefined;
}

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
  const location = useLocation();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [userError, setUserError] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false;
    try {
      return localStorage.getItem("donger_nav_collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [openParents, setOpenParents] = useState<Record<ParentItem["key"], boolean>>(() => {
    try {
      return {
        agents: localStorage.getItem("donger_nav_agents_open") === "1",
        workflows: localStorage.getItem("donger_nav_workflows_open") === "1",
        settings: localStorage.getItem("donger_nav_settings_open") === "1",
        observation: localStorage.getItem("donger_nav_observation_open") === "1",
      };
    } catch {
      return { agents: false, workflows: false, settings: false, observation: false };
    }
  });

  // 命中智能体子树自动展开
  useEffect(() => {
    const active = entries.find(
      (entry): entry is ParentItem =>
        isParent(entry) && entry.match.some((match) => location.pathname.startsWith(match)),
    );
    if (active) {
      setOpenParents((current) => ({ ...current, [active.key]: true }));
    }
  }, [location.pathname]);

  const toggleParent = (key: ParentItem["key"]) => {
    setOpenParents((current) => {
      const next = !current[key];
      try {
        localStorage.setItem(`donger_nav_${key}_open`, next ? "1" : "0");
      } catch {
        // 忽略
      }
      return { ...current, [key]: next };
    });
  };

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
      onClick={handleLogout}
      title="退出登录"
      aria-label="退出登录"
    >
      <LogOut size={iconSize} />
    </button>
  );

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
        {entries.map((e) => {
          if (!isParent(e)) {
            const Icon = e.icon;
            if (!Icon) return null;
            return collapsed ? (
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
            ) : (
              <NavLink key={e.to} to={e.to} end={e.end} onClick={onNavigate} className={linkClass}>
                <Icon size={18} className="shrink-0" />
                <span className="truncate">{e.label}</span>
              </NavLink>
            );
          }
          return (
            <div
              key={e.key}
              className={cn(collapsed ? "mt-3" : "mt-3 first:mt-0", "group relative")}
            >
              {collapsed ? (
                <>
                  <button
                    type="button"
                    aria-label={e.label}
                    className="relative flex h-9 w-full items-center justify-center rounded-lg text-sidebar-foreground transition-colors hover:bg-sidebar-hover hover:text-white"
                  >
                    <e.icon size={18} className="shrink-0" />
                    <ChevronRight size={9} className="absolute right-1.5 bottom-1 text-slate-500" />
                  </button>
                  <div className={flyoutClass}>
                    <div className="w-44 rounded-xl border border-border bg-card py-1.5 shadow-lg">
                      <div className="px-3 pb-1 pt-0.5 text-[11px] font-semibold text-muted-foreground">
                        {e.label}
                      </div>
                      {e.children.map((c) => (
                        <NavLink
                          key={c.to}
                          to={c.to}
                          onClick={onNavigate}
                          className={({ isActive }) =>
                            cn(
                              "flex items-center rounded-md px-3 py-2 text-[13px] text-foreground transition-colors hover:bg-muted",
                              isActive && "bg-primary-soft font-semibold text-primary",
                            )
                          }
                        >
                          {c.label}
                        </NavLink>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => toggleParent(e.key)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-hover hover:text-white"
                  >
                    <e.icon size={18} className="shrink-0" />
                    <span>{e.label}</span>
                    {openParents[e.key] ? (
                      <ChevronDown size={14} className="ml-auto opacity-60" />
                    ) : (
                      <ChevronRight size={14} className="ml-auto opacity-60" />
                    )}
                  </button>
                  {openParents[e.key] && (
                    <div className="ml-2 border-l border-white/10 pl-1.5">
                      {e.children.map((c) => (
                        <NavLink key={c.to} to={c.to} onClick={onNavigate} className={linkClass}>
                          {c.label}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {user ? (
        collapsed ? (
          <div className="group relative mt-3 flex justify-center">
            {avatar(26)}
            <div className={cn(flyoutClass, "top-auto bottom-0")}>
              <div className="w-44 rounded-xl border border-border bg-card p-2 shadow-lg">
                <div className="flex items-center gap-2 px-1 pb-1.5">
                  {avatar(20)}
                  <span className="max-w-[120px] truncate text-xs font-medium text-foreground">
                    {user.name}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
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
            <div className="flex items-center gap-2.5">
              {avatar(26)}
              <span className="max-w-[110px] truncate text-xs font-medium text-white">
                {user.name}
              </span>
            </div>
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
    </nav>
  );
}
