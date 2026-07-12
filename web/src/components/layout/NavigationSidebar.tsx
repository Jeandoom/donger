import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch, clearToken, getToken } from "../../lib/auth";
import { cn } from "../../lib/utils";

const items = [
  { to: "/", label: "会话", end: true },
  { to: "/agents", label: "智能体" },
  { to: "/workflows", label: "工作流" },
  { to: "/skills", label: "技能" },
  { to: "/credentials", label: "凭证" },
  { to: "/config", label: "配置" },
  { to: "/audit", label: "执行审计" },
];

interface UserInfo {
  id: string;
  name: string;
  avatar?: string;
  role: string;
}

export function NavigationSidebar() {
  const navigate = useNavigate();
  const [user, setUser] = useState<UserInfo | null>(null);

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
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          className={({ isActive }) =>
            cn(
              "rounded-md px-3 py-2 text-sm",
              isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent",
            )
          }
        >
          {it.label}
        </NavLink>
      ))}

      {/* 底部：用户信息 + 退出 */}
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
