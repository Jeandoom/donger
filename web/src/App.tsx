import { Link, Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { AuthGuard } from "./components/auth/AuthGuard";
import { Shell } from "./components/layout/Shell";
import { PwaUpdatePrompt } from "./components/pwa/PwaUpdatePrompt";
import { AgentEditorPage } from "./pages/AgentEditorPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AuditPage } from "./pages/AuditPage";
import { ChatPage } from "./pages/ChatPage";
import { ConnectorsPage } from "./pages/ConnectorsPage";
import { CredentialsPage } from "./pages/CredentialsPage";
import { InvitesPage } from "./pages/InvitesPage";
import { LlmSessionsPage } from "./pages/LlmSessionsPage";
import { LoginPage } from "./pages/LoginPage";
import { LoginSuccessPage } from "./pages/LoginSuccessPage";
import { LoopDetailPage } from "./pages/LoopDetailPage";
import { LoopsPage } from "./pages/LoopsPage";
import { ModelsPage } from "./pages/ModelsPage";
import { RegisterPage } from "./pages/RegisterPage";
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
      <PwaUpdatePrompt />
      <Routes>
        {/* 登录相关路由（免认证） */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login/success" element={<LoginSuccessPage />} />
        {/* 邮箱注册（免认证；持邀请链接不受域名白名单限制） */}
        <Route path="/register" element={<RegisterPage />} />
        {/* 分享落地页（公开；登录后自动授权进入） */}
        <Route path="/share/:token" element={<ShareLandingPage />} />
        {/* 合并流程已废弃：旧链接重定向到登录页 */}
        <Route path="/login/merge" element={<Navigate to="/login" replace />} />

        {/* 需要登录的路由（页面级崩溃由 Shell 内的 PageErrorBoundary 兜底） */}
        <Route element={<AuthGuard />}>
          <Route element={<Shell />}>
            <Route path="/" element={<ChatPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/new" element={<AgentEditorPage />} />
            <Route path="/agents/:id" element={<AgentEditorPage />} />
            <Route path="/agents/:id/chat" element={<AgentChatRedirect />} />
            <Route path="/agent-sessions" element={<AgentSessionsRedirect />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/new" element={<WorkflowEditorPage />} />
            <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
            <Route path="/triggers" element={<TriggersPage />} />
            <Route path="/triggers/new" element={<TriggerEditorPage />} />
            <Route path="/triggers/:id" element={<TriggerEditorPage />} />
            <Route path="/loops" element={<LoopsPage />} />
            <Route path="/loops/:id" element={<LoopDetailPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/connectors" element={<ConnectorsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
            <Route path="/settings/profile" element={<UserProfilePage />} />
            <Route path="/settings/invites" element={<InvitesPage />} />
            <Route path="/settings/models" element={<ModelsPage />} />
            <Route path="/settings/credentials" element={<CredentialsPage />} />
            <Route path="/credentials" element={<Navigate to="/settings/credentials" replace />} />
            <Route path="/audit" element={<Navigate to="/audit/history" replace />} />
            <Route path="/audit/history" element={<AuditPage />} />
            <Route path="/audit/llm" element={<LlmSessionsPage />} />
            {/* 未匹配路由兜底：避免渲染空白页 */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}

/** 404 兜底页：给出导航出口而非空白 */
function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <div className="text-5xl font-bold text-primary">404</div>
      <div>页面不存在或已下线</div>
      <Link
        to="/"
        className="rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90"
      >
        返回会话
      </Link>
    </div>
  );
}

/** /agents/:id/chat → 对话模块并定位该智能体（继续最近会话；没有才新建） */
function AgentChatRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/?agent=${id}` : "/"} replace />;
}

/** /agent-sessions → 对话模块（智能体会话已并入；?agent= 深链透传，保住旧书签/PWA 入口） */
function AgentSessionsRedirect() {
  const [params] = useSearchParams();
  return <Navigate to={{ pathname: "/", search: params.toString() }} replace />;
}
