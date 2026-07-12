import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { apiFetch, clearToken, getToken } from "../../lib/auth";
import { cn } from "../../lib/utils";

const NAV_KEY = "donger_nav_agents_open";

interface LeafItem {
  to: string;
  label: string;
  end?: boolean;
}
interface ParentItem {
  label: string;
  /** 命中即视为该父项激活（用于自动展开） */
  match: string[];
  children: LeafItem[];
}
type NavEntry = LeafItem | ParentItem;

const entries: NavEntry[] = [
  { to: "/", label: "会话", end: true },
  {
    label: "智能体",
    match: ["/agents", "/agent-sessions"],
    children: [
      { to: "/agents", label: "智能体管理" },
      { to: "/agent-sessions", label: "智能体会话" },
    ],
  },
  { to: "/workflows", label: "工作流" },
  { to: "/skills", label: "技能" },
  { to: "/config", label: "配置" },
  { to: "/audit", label: "执行审计" },
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

export function NavigationSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [agentsOpen, setAgentsOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(NAV_KEY) === "1";
    } catch {
      return false;
    }
  });

  // 命中智能体子树自动展开
  useEffect(() => {
    if (entries.some((e) => isParent(e) && e.match.some((m) => location.pathname.startsWith(m)))) {
      setAgentsOpen(true);
    }
  }, [location.pathname]);

  const toggleAgents = () => {
    setAgentsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(NAV_KEY, next ? "1" : "0");
      } catch {
        // 忽略
      }
      return next;
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
    <nav className="flex h-full w-48 flex-col border-r border-border bg-muted/40 p-2">
      <div className="px-2 py-3 text-sm font-semibold">🤖 donger</div>
      {entries.map((e) =>
        isParent(e) ? (
          <div key={e.label} className="mb-0.5">
            <button
              type="button"
              onClick={toggleAgents}
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <span>{e.label}</span>
              <span className="text-xs text-muted-foreground">{agentsOpen ? "▾" : "▸"}</span>
            </button>
            {agentsOpen && (
              <div className="ml-2 border-l border-border pl-2">
                {e.children.map((c) => (
                  <NavLink
                    key={c.to}
                    to={c.to}
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
