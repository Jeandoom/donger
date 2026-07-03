import { Outlet } from "react-router-dom";
import { NavigationSidebar } from "./NavigationSidebar";

export function Shell() {
  return (
    <div className="flex h-screen">
      <NavigationSidebar />
      <Outlet />
    </div>
  );
}
