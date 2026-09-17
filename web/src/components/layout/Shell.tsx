import { Outlet } from "react-router-dom";
import { OfflineBanner } from "../pwa/OfflineBanner";
import { MobileNavigationDrawer } from "./MobileNavigationDrawer";
import { NavigationSidebar } from "./NavigationSidebar";
import { PageErrorBoundary } from "./PageErrorBoundary";

export function Shell() {
  return (
    <div className="flex h-[100dvh] min-w-0 flex-col overflow-hidden">
      {/* 离线横幅入文档流：不能用 fixed 覆盖，否则移动端会盖住汉堡菜单导致无法导航 */}
      <OfflineBanner />
      <div className="flex min-h-0 min-w-0 flex-1">
        <NavigationSidebar className="hidden lg:flex" />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center border-b border-border bg-card px-2 lg:hidden">
            <MobileNavigationDrawer />
            <img src="/pwa-icon.svg" alt="donger logo" className="ml-2 h-5 w-5 rounded" />
            <span className="ml-1.5 text-sm font-bold">donger</span>
          </header>
          <main className="flex min-h-0 min-w-0 flex-1">
            <PageErrorBoundary>
              <Outlet />
            </PageErrorBoundary>
          </main>
        </div>
      </div>
    </div>
  );
}
