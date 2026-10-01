import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDTO, AgentMeta } from "../src/lib/agents";
import type { KbLibraryDTO } from "../src/lib/kb";
import { AgentEditorPage } from "../src/pages/AgentEditorPage";

// 独立知识库（可写目标）勾选化（specs/2026-10-01-agent-own-kb-picker-design.md §2.1）：
// 候选过滤（个人库/共享只读库不出现）、单选互斥+绑定联动+徽标、新建伪行默认名兜底建库。

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

const metaFixture: AgentMeta = { skills: [], skillGroups: [], tools: [], llmPresets: [] };

const kbFixture: KbLibraryDTO[] = [
  {
    id: "kb-own",
    name: "stock-lab",
    description: "",
    builtin: false,
    personal: false,
    updatedAt: "2026-10-01T00:00:00Z",
    _mine: true,
    _role: "manage",
  },
  {
    id: "kb-own2",
    name: "stock-lab-kb",
    description: "",
    builtin: false,
    personal: false,
    updatedAt: "2026-10-01T00:00:00Z",
    _mine: true,
    _role: "manage",
  },
  {
    id: "kb-personal",
    name: "个人知识库",
    description: "",
    builtin: false,
    personal: true,
    updatedAt: "2026-10-01T00:00:00Z",
    _mine: true,
    _role: "manage",
  },
  {
    id: "kb-shared",
    name: "shared-lib",
    description: "",
    builtin: false,
    personal: false,
    updatedAt: "2026-10-01T00:00:00Z",
    _mine: false,
    _role: "use",
  },
];

/** FormField 以 label 文本定位字段容器（span → 行 div → 字段 div） */
function kbField(label: string): HTMLElement {
  const field = screen.getByText(label).parentElement?.parentElement;
  if (!field) throw new Error(`FormField 未找到: ${label}`);
  return field;
}

function renderEditor(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
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
  const saveButtons = screen.getAllByRole("button", { name: "保存" });
  fireEvent.click(saveButtons[0] as Element);
}

describe("AgentEditorPage 独立知识库勾选", () => {
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
    agentMocks.fetchAgent.mockRejectedValue(new Error("skip"));
    otherMocks.fetchCredentialTemplates.mockResolvedValue([]);
    otherMocks.fetchMyCredentials.mockResolvedValue([]);
    otherMocks.fetchConnectors.mockResolvedValue([]);
    otherMocks.fetchKnowledgeBases.mockResolvedValue(kbFixture);
    otherMocks.createKb.mockResolvedValue({
      id: "kb-new",
      name: "e2e-agent-知识库",
      description: "",
      builtin: false,
      personal: false,
      updatedAt: "2026-10-01T00:00:00Z",
      _mine: true,
      _role: "manage",
    } satisfies KbLibraryDTO);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("独立库候选只含本人可管理库：个人库与共享只读库不出现", async () => {
    renderEditor("/agents/new");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(3);
    });
    const field = kbField("独立知识库");
    expect(within(field).getByText("stock-lab")).toBeInTheDocument();
    expect(within(field).getByText("stock-lab-kb")).toBeInTheDocument();
    expect(within(field).queryByText("个人知识库")).not.toBeInTheDocument();
    expect(within(field).queryByText("shared-lib")).not.toBeInTheDocument();
    // 绑定列表不受限：个人库/共享库照常出现
    const boundField = kbField("绑定的知识库");
    expect(within(boundField).getByText("个人知识库")).toBeInTheDocument();
    expect(within(boundField).getByText("shared-lib")).toBeInTheDocument();
  });

  it("单选互斥：改选另一库自动取消原目标，绑定联动勾上并显示「独立·可写」", async () => {
    renderEditor("/agents/new");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(3);
    });
    const field = kbField("独立知识库");
    const boundField = kbField("绑定的知识库");
    const [first, second] = within(field).getAllByRole("checkbox");
    fireEvent.click(first as Element);
    expect((first as HTMLInputElement).checked).toBe(true);
    expect(within(boundField).getByText("独立·可写")).toBeInTheDocument();
    fireEvent.click(second as Element);
    expect((first as HTMLInputElement).checked).toBe(false);
    expect((second as HTMLInputElement).checked).toBe(true);
  });

  it("勾选已有库保存：PATCH/POST 载荷带 kbWriteTargetId 且并入绑定", async () => {
    agentMocks.createAgent.mockResolvedValue({
      id: "ag-1",
      ownerId: "u1",
      name: "e2e-agent",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      gitRepositories: [],
      extensionDirectories: [],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    } satisfies AgentDTO);
    renderEditor("/agents/new");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(3);
    });
    fireEvent.click(within(kbField("独立知识库")).getAllByRole("checkbox")[0] as Element);
    await fillNameAndSave("e2e-agent");
    await waitFor(() => {
      expect(agentMocks.createAgent).toHaveBeenCalledTimes(1);
    });
    const payload = agentMocks.createAgent.mock.calls[0]?.[0] as {
      kbWriteTargetId?: string;
      knowledgeBaseIds?: string[];
    };
    expect(payload.kbWriteTargetId).toBe("kb-own");
    expect(payload.knowledgeBaseIds).toContain("kb-own");
  });

  it("新建伪行：展开命名输入，留空保存按默认名建库并回填目标", async () => {
    agentMocks.createAgent.mockResolvedValue({
      id: "ag-1",
      ownerId: "u1",
      name: "e2e-agent",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      gitRepositories: [],
      extensionDirectories: [],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    } satisfies AgentDTO);
    renderEditor("/agents/new");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(3);
    });
    const field = kbField("独立知识库");
    fireEvent.click(within(field).getAllByRole("checkbox")[2] as Element);
    const nameInput = await screen.findByLabelText("新建独立知识库名称");
    expect((nameInput as HTMLInputElement).value).toBe("");
    await fillNameAndSave("e2e-agent");
    await waitFor(() => {
      expect(agentMocks.createAgent).toHaveBeenCalledTimes(1);
    });
    expect(otherMocks.createKb).toHaveBeenCalledWith(
      expect.objectContaining({ name: "e2e-agent-知识库" }),
    );
    const payload = agentMocks.createAgent.mock.calls[0]?.[0] as {
      kbWriteTargetId?: string;
      knowledgeBaseIds?: string[];
    };
    expect(payload.kbWriteTargetId).toBe("kb-new");
    expect(payload.knowledgeBaseIds).toContain("kb-new");
  });
});
