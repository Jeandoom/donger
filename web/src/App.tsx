import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGuard } from "./components/auth/AuthGuard";
import { Shell } from "./components/layout/Shell";
import { AgentChatPage } from "./pages/AgentChatPage";
import { AgentEditorPage } from "./pages/AgentEditorPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AuditPage } from "./pages/AuditPage";
import { ChatPage } from "./pages/ChatPage";
import { ConfigPage } from "./pages/ConfigPage";
import { LoginPage } from "./pages/LoginPage";
import { LoginSuccessPage } from "./pages/LoginSuccessPage";
import { ShareLandingPage } from "./pages/ShareLandingPage";
import { SkillsPage } from "./pages/SkillsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";

export function App() {
  return (
    <Routes>
      {/* 登录相关路由（免认证） */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/success" element={<LoginSuccessPage />} />
      {/* 分享落地页（公开；登录后自动授权进入） */}
      <Route path="/share/:token" element={<ShareLandingPage />} />
      {/* 合并流程已废弃：旧链接重定向到登录页 */}
      <Route path="/login/merge" element={<Navigate to="/login" replace />} />

      {/* 需要登录的路由 */}
      <Route element={<AuthGuard />}>
        <Route element={<Shell />}>
          <Route path="/" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<AgentEditorPage />} />
          <Route path="/agents/:id" element={<AgentEditorPage />} />
          <Route path="/agents/:id/chat" element={<AgentChatPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/audit" element={<AuditPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
