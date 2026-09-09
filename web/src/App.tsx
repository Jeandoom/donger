import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AuthGuard } from "./components/auth/AuthGuard";
import { Shell } from "./components/layout/Shell";
import { OfflineBanner } from "./components/pwa/OfflineBanner";
import { PwaUpdatePrompt } from "./components/pwa/PwaUpdatePrompt";
import { AgentEditorPage } from "./pages/AgentEditorPage";
import { AgentSessionsPage } from "./pages/AgentSessionsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AuditPage } from "./pages/AuditPage";
import { ChatPage } from "./pages/ChatPage";
import { CredentialsPage } from "./pages/CredentialsPage";
import { LlmSessionsPage } from "./pages/LlmSessionsPage";
import { LoginPage } from "./pages/LoginPage";
import { LoginSuccessPage } from "./pages/LoginSuccessPage";
import { LoopDetailPage } from "./pages/LoopDetailPage";
import { LoopsPage } from "./pages/LoopsPage";
import { ModelsPage } from "./pages/ModelsPage";
import { ShareLandingPage } from "./pages/ShareLandingPage";
import { SkillsPage } from "./pages/SkillsPage";
import { TriggerEditorPage } from "./pages/TriggerEditorPage";
import { TriggersPage } from "./pages/TriggersPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { WorkflowEditorPage } from "./pages/WorkflowEditorPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";

export function App() {
  return (
    <>
      <OfflineBanner />
      <PwaUpdatePrompt />
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
            <Route path="/agents/:id/chat" element={<AgentChatRedirect />} />
            <Route path="/agent-sessions" element={<AgentSessionsPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/new" element={<WorkflowEditorPage />} />
            <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
            <Route path="/triggers" element={<TriggersPage />} />
            <Route path="/triggers/new" element={<TriggerEditorPage />} />
            <Route path="/triggers/:id" element={<TriggerEditorPage />} />
            <Route path="/loops" element={<LoopsPage />} />
            <Route path="/loops/:id" element={<LoopDetailPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
            <Route path="/settings/profile" element={<UserProfilePage />} />
            <Route path="/settings/models" element={<ModelsPage />} />
            <Route path="/settings/credentials" element={<CredentialsPage />} />
            <Route path="/credentials" element={<Navigate to="/settings/credentials" replace />} />
            <Route path="/audit" element={<Navigate to="/audit/history" replace />} />
            <Route path="/audit/history" element={<AuditPage />} />
            <Route path="/audit/llm" element={<LlmSessionsPage />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}

/** /agents/:id/chat → 智能体会话页并定位该智能体（继续最近会话；没有才新建） */
function AgentChatRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/agent-sessions?agent=${id}` : "/agent-sessions"} replace />;
}
