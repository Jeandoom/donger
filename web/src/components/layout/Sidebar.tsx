import { NavLink } from "react-router-dom";
import { cn } from "../../lib/utils";

const items = [
  { to: "/", label: "会话", end: true },
  { to: "/agents", label: "智能体" },
  { to: "/workflows", label: "工作流" },
  { to: "/skills", label: "技能" },
  { to: "/config", label: "配置" },
  { to: "/audit", label: "执行审计" },
];

export function Sidebar() {
  return (
    <nav className="flex h-full w-52 flex-col border-r border-border bg-muted/40 p-2">
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
    </nav>
  );
}
