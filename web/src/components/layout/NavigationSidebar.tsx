import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { apiFetch, clearToken, getToken } from "../../lib/auth";
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
  { to: "/", label: "会话", end: true },
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
    key: "settings",
    label: "用户配置",
    match: ["/settings"],
    children: [
      { to: "/settings/profile", label: "基本信息" },
      { to: "/settings/models", label: "Models" },
      { to: "/settings/credentials", label: "凭证" },
    ],
  },
  {
    key: "observation",
    label: "会话观测",
    match: ["/audit"],
    children: [
      { to: "/audit/history", label: "历史会话" },
      { to: "/audit/llm", label: "LLM 会话" },
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

  useEffect(() => {
    if (getToken()) {
      apiFetch("/api/auth/me")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.user) setUser(data.user);
        })
        .catch(() => {});
    }
  }, []);

  const handleLogout = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    clearToken();
    navigate("/login");
  };

  return (
    <nav
      className={cn("flex h-full w-48 flex-col border-r border-border bg-muted/40 p-2", className)}
    >
      <div className="flex items-center gap-2 px-2 py-3 text-sm font-semibold">
        <img src="/pwa-icon.svg" alt="donger logo" className="h-5 w-5" />
        donger
      </div>
      {entries.map((e) =>
        isParent(e) ? (
          <div key={e.key} className="mb-0.5">
            <button
              type="button"
              onClick={() => toggleParent(e.key)}
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <span>{e.label}</span>
              <span className="text-xs text-muted-foreground">
                {openParents[e.key] ? "▾" : "▸"}
              </span>
            </button>
            {openParents[e.key] && (
              <div className="ml-2 border-l border-border pl-2">
                {e.children.map((c) => (
                  <NavLink
                    key={c.to}
                    to={c.to}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "block rounded-md px-3 py-1.5 text-sm",
                        isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent",
                      )
                    }
                  >
                    {c.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        ) : (
          <NavLink
            key={e.to}
            to={e.to}
            end={e.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "block rounded-md px-3 py-2 text-sm",
                isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent",
              )
            }
          >
            {e.label}
          </NavLink>
        ),
      )}

      <div className="mt-auto border-t border-border pt-2">
        {user ? (
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full" />
                ) : (
                  user.name.charAt(0)
                )}
              </div>
              <span className="max-w-[100px] truncate text-xs text-muted-foreground">
                {user.name}
              </span>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-destructive"
              onClick={handleLogout}
              title="退出登录"
            >
              ⏻
            </button>
          </div>
        ) : (
          <div className="px-2 py-1 text-xs text-muted-foreground">未登录</div>
        )}
      </div>
    </nav>
  );
}
