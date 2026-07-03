import { Route, Routes } from "react-router-dom";
import { Shell } from "./components/layout/Shell";
import { AuthGuard } from "./components/auth/AuthGuard";
import { LoginPage } from "./pages/LoginPage";
import { LoginSuccessPage } from "./pages/LoginSuccessPage";
import { MergePage } from "./pages/MergePage";
import { AgentsPage } from "./pages/AgentsPage";
import { AuditPage } from "./pages/AuditPage";
import { ChatPage } from "./pages/ChatPage";
import { ConfigPage } from "./pages/ConfigPage";
import { SkillsPage } from "./pages/SkillsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";

export function App() {
  return (
    <Routes>
      {/* 登录相关路由（免认证） */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/success" element={<LoginSuccessPage />} />
      <Route path="/login/merge" element={<MergePage />} />

      {/* 需要登录的路由 */}
      <Route element={<AuthGuard />}>
        <Route element={<Shell />}>
          <Route path="/" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/audit" element={<AuditPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
