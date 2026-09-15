import { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { apiFetch, apiFetchRetry, clearToken, getToken } from "../../lib/auth";
import { cn } from "../../lib/utils";

interface LeafItem {
  to: string;
  label: string;
  end?: boolean;
}
interface ParentItem {
  key: "agents" | "workflows" | "settings" | "observation";
  label: string;
  /** 命中即视为该父项激活（用于自动展开） */
  match: string[];
  children: LeafItem[];
}
type NavEntry = LeafItem | ParentItem;

const entries: NavEntry[] = [
  { to: "/", label: "对话", end: true },
  {
    key: "agents",
    label: "智能体",
    match: ["/agents", "/agent-sessions"],
    children: [
      { to: "/agents", label: "智能体管理" },
      { to: "/agent-sessions", label: "智能体会话" },
    ],
  },
  {
    key: "workflows",
    label: "工作流",
    match: ["/workflows", "/triggers"],
    children: [
      { to: "/workflows", label: "工作流管理" },
      { to: "/triggers", label: "触发器管理" },
    ],
  },
  { to: "/loops", label: "LOOPs" },
  { to: "/skills", label: "技能" },
  { to: "/connectors", label: "连接器" },
  {
    key: "observation",
    label: "审计",
    match: ["/audit"],
    children: [
      { to: "/audit/history", label: "历史会话" },
      { to: "/audit/llm", label: "LLM 观测" },
    ],
  },
  {
    key: "settings",
    label: "设置",
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

export function NavigationSidebar({
  className,
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [userError, setUserError] = useState(false);
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

  return (
    <nav className={cn("flex h-full w-60 flex-col bg-sidebar px-3 pb-4 pt-5", className)}>
      <div className="flex items-center gap-2.5 px-2 pb-4">
        <img src="/pwa-icon.svg" alt="donger logo" className="h-7 w-7 rounded-lg" />
        <span className="text-[17px] font-bold text-white">donger</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {entries.map((e) =>
          isParent(e) ? (
            <div key={e.key} className="mt-3 first:mt-0">
              <button
                type="button"
                onClick={() => toggleParent(e.key)}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-hover hover:text-white"
              >
                <span>{e.label}</span>
                <span className="text-xs opacity-60">{openParents[e.key] ? "▾" : "▸"}</span>
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
            </div>
          ) : (
            <NavLink key={e.to} to={e.to} end={e.end} onClick={onNavigate} className={linkClass}>
              {e.label}
            </NavLink>
          ),
        )}
      </div>

      {user ? (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-sidebar-hover px-2.5 py-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-cyan-400 text-[11px] font-bold text-sidebar">
              {user.avatar ? (
                <img src={user.avatar} alt="" className="h-full w-full rounded-full" />
              ) : (
                user.name.charAt(0)
              )}
            </div>
            <span className="max-w-[110px] truncate text-xs font-medium text-white">
              {user.name}
            </span>
          </div>
          <button
            type="button"
            className="text-xs text-sidebar-foreground hover:text-white"
            onClick={handleLogout}
            title="退出登录"
          >
            ⏻
          </button>
        </div>
      ) : userError ? (
        <button
          type="button"
          className="mt-3 w-full rounded-lg bg-sidebar-hover px-2.5 py-2 text-left text-xs text-sidebar-foreground hover:text-white"
          onClick={() => void loadUser()}
        >
          用户信息加载失败，点击重试
        </button>
      ) : (
        <div className="px-2.5 py-2 text-xs text-sidebar-foreground">未登录</div>
      )}
    </nav>
  );
}
