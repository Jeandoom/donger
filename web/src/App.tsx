import { Route, Routes } from "react-router-dom";
import { Shell } from "./components/layout/Shell";
import { AgentsPage } from "./pages/AgentsPage";
import { ChatPage } from "./pages/ChatPage";
import { ConfigPage } from "./pages/ConfigPage";
import { SkillsPage } from "./pages/SkillsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<ChatPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/config" element={<ConfigPage />} />
      </Route>
    </Routes>
  );
}
