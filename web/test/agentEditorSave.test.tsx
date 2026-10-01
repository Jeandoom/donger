import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEditorPage } from "../src/pages/AgentEditorPage";
import type { AgentDTO, AgentMeta } from "../src/lib/agents";

// 回归背景：创建保存返回装备告警时页面曾停留在 /agents/new，再次点保存重复创建智能体。
// 断言核心：创建落库后必须切到 /agents/:id，后续保存走 updateAgent。

const agentMocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgentMeta: vi.fn(),
  fetchAgents: vi.fn(),
  duplicateAgent: vi.fn(),
  fetchAgentCallback: vi.fn(),
  generateAgentCallback: vi.fn(),
  revokeAgentCallback: vi.fn(),
}));

const otherMocks = vi.hoisted(() => ({
  fetchCredentialTemplates: vi.fn(),
  fetchMyCredentials: vi.fn(),
  createKb: vi.fn(),
  fetchKnowledgeBases: vi.fn(),
  fetchConnectors: vi.fn(),
}));

vi.mock("../src/lib/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/agents")>()),
  ...agentMocks,
}));

vi.mock("../src/lib/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/skills")>()),
  fetchCredentialTemplates: otherMocks.fetchCredentialTemplates,
  fetchMyCredentials: otherMocks.fetchMyCredentials,
}));

vi.mock("../src/lib/kb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/kb")>()),
  createKb: otherMocks.createKb,
  fetchKnowledgeBases: otherMocks.fetchKnowledgeBases,
}));

vi.mock("../src/lib/connectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/connectors")>()),
  fetchConnectors: otherMocks.fetchConnectors,
}));

const agentFixture: AgentDTO = {
  id: "ag-1",
  ownerId: "u1",
  name: "e2e-agent",
  description: "",
  skills: [],
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  gitRepositories: [],
  extensionDirectories: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const metaFixture: AgentMeta = { skills: [], skillGroups: [], tools: [], llmPresets: [] };

let currentPath = "";
let currentState: unknown;
function LocationProbe() {
  const location = useLocation();
  currentPath = location.pathname;
  currentState = location.state;
  return null;
}

function renderEditor(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/agents/new" element={<AgentEditorPage />} />
        <Route path="/agents/:id" element={<AgentEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillNameAndSave(name: string) {
  const input = screen.getByPlaceholderText("如 donger-code-agent");
  fireEvent.change(input, { target: { value: name } });
  // 顶栏与底部栏各有一个保存按钮，行为一致
  const saveButtons = screen.getAllByRole("button", { name: "保存" });
  fireEvent.click(saveButtons[0] as Element);
}

describe("AgentEditorPage 保存流程", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    agentMocks.fetchAgentMeta.mockResolvedValue(metaFixture);
    agentMocks.fetchAgents.mockResolvedValue([]);
    agentMocks.fetchAgentCallback.mockRejectedValue(new Error("skip"));
    otherMocks.fetchCredentialTemplates.mockResolvedValue([]);
    otherMocks.fetchMyCredentials.mockResolvedValue([]);
    otherMocks.fetchKnowledgeBases.mockResolvedValue([]);
    otherMocks.fetchConnectors.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("创建保存返回装备告警时切到编辑态，再次保存走更新而非重复创建", async () => {
    agentMocks.createAgent.mockResolvedValue({
      ...agentFixture,
      warnings: ["[code-dev] code-dev 场景要求至少绑定一个 git 仓库"],
    });
    agentMocks.fetchAgent.mockResolvedValue(agentFixture);
    agentMocks.updateAgent.mockResolvedValue(agentFixture);

    renderEditor("/agents/new");
    await fillNameAndSave("e2e-agent");

    await waitFor(() => {
      expect(currentPath).toBe("/agents/ag-1");
    });
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(1);
    expect(agentMocks.fetchAgent).toHaveBeenCalledWith("ag-1");
    // 告警横幅仍在（经组件 state 与路由 state 双通道）
    expect(screen.getByText(/装备提示/)).toBeInTheDocument();
    expect(currentState).toMatchObject({ warnings: ["[code-dev] code-dev 场景要求至少绑定一个 git 仓库"] });

    // 编辑态加载完成后再次保存：必须是 PATCH 更新，不能重复创建
    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText("如 donger-code-agent") as HTMLInputElement;
      expect(nameInput.value).toBe("e2e-agent");
    });
    await fillNameAndSave("e2e-agent");
    await waitFor(() => {
      expect(agentMocks.updateAgent).toHaveBeenCalledTimes(1);
    });
    expect(agentMocks.updateAgent).toHaveBeenCalledWith("ag-1", expect.objectContaining({ name: "e2e-agent" }));
    expect(agentMocks.createAgent).toHaveBeenCalledTimes(1);
  });

  it("编辑态保存返回装备告警时留在本页展示告警（不跳转）", async () => {
    agentMocks.fetchAgent.mockResolvedValue(agentFixture);
    agentMocks.updateAgent.mockResolvedValue({
      ...agentFixture,
      warnings: ["凭证 git-token 的值尚未配置（执行时将触发问询）"],
    });

    renderEditor("/agents/ag-1");
    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText("如 donger-code-agent") as HTMLInputElement;
      expect(nameInput.value).toBe("e2e-agent");
    });

    await fillNameAndSave("e2e-agent");

    await waitFor(() => {
      expect(agentMocks.updateAgent).toHaveBeenCalledTimes(1);
    });
    expect(currentPath).toBe("/agents/ag-1");
    expect(screen.getByText(/装备提示/)).toBeInTheDocument();
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });
});
