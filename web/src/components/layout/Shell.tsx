import { Outlet } from "react-router-dom";
import { MobileNavigationDrawer } from "./MobileNavigationDrawer";
import { NavigationSidebar } from "./NavigationSidebar";

export function Shell() {
  return (
    <div className="flex h-[100dvh] min-w-0 overflow-hidden">
      <NavigationSidebar className="hidden lg:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-2 lg:hidden">
          <MobileNavigationDrawer />
          <span className="ml-2 text-sm font-semibold">🤖 donger</span>
        </header>
        <main className="flex min-h-0 min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
