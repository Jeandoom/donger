import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDTO, AgentMeta } from "../src/lib/agents";
import type { KbLibraryDTO } from "../src/lib/kb";
import { AgentEditorPage } from "../src/pages/AgentEditorPage";

// 独立知识库 = 专有库单选项（2026-10-26 修订）：勾选即绑定并作为可写目标；无专有库时
// 保存时自动建库（默认名「{agent名}-知识库」，重名加序号）；已有专有库可经「改名」弹窗
// 变更名称（唯一性校验，取消/关闭不生效）。用户知识库 = 本人可见全量剔除智能体专有库。

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
  updateKb: vi.fn(),
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
  updateKb: otherMocks.updateKb,
  fetchKnowledgeBases: otherMocks.fetchKnowledgeBases,
}));

vi.mock("../src/lib/connectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/connectors")>()),
  fetchConnectors: otherMocks.fetchConnectors,
}));

const metaFixture: AgentMeta = { skills: [], skillGroups: [], tools: [], llmPresets: [] };

function kbDTO(partial: Partial<KbLibraryDTO> & Pick<KbLibraryDTO, "id" | "name">): KbLibraryDTO {
  return {
    description: "",
    builtin: false,
    personal: false,
    updatedAt: "2026-10-01T00:00:00Z",
    _mine: true,
    _role: "manage",
    ...partial,
  };
}

/** 默认夹具：本人专有库（ag-1）+ 他智能体专有库 + 普通库 + 个人库 + 共享只读库 */
const kbFixture: KbLibraryDTO[] = [
  kbDTO({ id: "kb-own", name: "own-agent-kb", sourceAgentId: "ag-1" }),
  kbDTO({ id: "kb-other", name: "别家专有库", sourceAgentId: "ag-other" }),
  kbDTO({ id: "kb-normal", name: "普通共享库" }),
  kbDTO({ id: "kb-personal", name: "个人知识库", personal: true }),
  kbDTO({ id: "kb-shared", name: "shared-lib", _mine: false, _role: "use" }),
];

const agentFixture: AgentDTO = {
  id: "ag-1",
  ownerId: "u1",
  name: "stock-lab",
  skills: [],
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  gitRepositories: [],
  extensionDirectories: [],
  knowledgeBaseIds: ["kb-own"],
  kbWriteTargetId: "kb-own",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const createdAgent: AgentDTO = {
  id: "ag-1",
  ownerId: "u1",
  name: "stock-lab",
  skills: [],
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  gitRepositories: [],
  extensionDirectories: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

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

function typeName(name: string) {
  fireEvent.change(screen.getByPlaceholderText("如 donger-code-agent"), {
    target: { value: name },
  });
}

function clickSave() {
  // 顶栏与底部栏各有一个保存按钮，行为一致
  fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0] as Element);
}

describe("AgentEditorPage 独立知识库（专有库单选项）", () => {
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
    otherMocks.createKb.mockResolvedValue(
      kbDTO({ id: "kb-new", name: "stock-lab-知识库" }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("用户知识库展示本人可见全量；智能体专有库不进候选（他智能体不可见）", async () => {
    agentMocks.fetchAgent.mockResolvedValue(agentFixture);
    renderEditor("/agents/ag-1");
    await waitFor(() => {
      expect(within(kbField("用户知识库")).getAllByRole("checkbox")).toHaveLength(3);
    });
    const boundField = kbField("用户知识库");
    expect(within(boundField).getByText("普通共享库")).toBeInTheDocument();
    expect(within(boundField).getByText("个人知识库")).toBeInTheDocument();
    expect(within(boundField).getByText("shared-lib")).toBeInTheDocument();
    // 他智能体专有库不可见；本人专有库由独立知识库行单一承载，不在用户库列表重复出现
    expect(within(boundField).queryByText("别家专有库")).not.toBeInTheDocument();
    expect(within(boundField).queryByText("own-agent-kb")).not.toBeInTheDocument();
    // 独立知识库 = 单选项：已有专有库勾选展示 + 改名按钮
    const standaloneField = kbField("独立知识库");
    expect(within(standaloneField).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(standaloneField).getByText("own-agent-kb")).toBeInTheDocument();
    expect(within(standaloneField).getByRole("button", { name: "改名" })).toBeInTheDocument();
  });

  it("新建态：单选项自动命名（无输入框），保存按默认名建库并回填目标", async () => {
    agentMocks.createAgent.mockResolvedValue(createdAgent);
    renderEditor("/agents/new");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(1);
    });
    typeName("stock-lab");
    // 默认名随名称输入实时生成
    expect(within(kbField("独立知识库")).getByText("stock-lab-知识库")).toBeInTheDocument();
    fireEvent.click(within(kbField("独立知识库")).getByRole("checkbox"));
    // 不再展开命名输入框；展示「保存时自动创建」语义
    expect(screen.queryByLabelText("新建独立知识库名称")).not.toBeInTheDocument();
    expect(within(kbField("独立知识库")).getByText(/保存时自动创建/)).toBeInTheDocument();
    clickSave();
    await waitFor(() => {
      expect(agentMocks.createAgent).toHaveBeenCalledTimes(1);
    });
    expect(otherMocks.createKb).toHaveBeenCalledWith(
      expect.objectContaining({ name: "stock-lab-知识库" }),
    );
    const payload = agentMocks.createAgent.mock.calls[0]?.[0] as {
      kbWriteTargetId?: string;
      knowledgeBaseIds?: string[];
    };
    expect(payload.kbWriteTargetId).toBe("kb-new");
    expect(payload.knowledgeBaseIds).toContain("kb-new");
  });

  it("待建默认名与本人既有库重名时自动加序号", async () => {
    otherMocks.fetchKnowledgeBases.mockResolvedValue([
      ...kbFixture,
      kbDTO({ id: "kb-clash", name: "stock-lab-知识库" }),
    ]);
    renderEditor("/agents/new");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(1);
    });
    typeName("stock-lab");
    expect(within(kbField("独立知识库")).getByText("stock-lab-知识库-2")).toBeInTheDocument();
  });

  it("保存建库遇重名 409 自动加序号重试", async () => {
    agentMocks.createAgent.mockResolvedValue(createdAgent);
    otherMocks.createKb.mockRejectedValueOnce(new Error("已存在同名知识库")).mockResolvedValueOnce(
      kbDTO({ id: "kb-new-2", name: "stock-lab-知识库-2" }),
    );
    renderEditor("/agents/new");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(1);
    });
    typeName("stock-lab");
    fireEvent.click(within(kbField("独立知识库")).getByRole("checkbox"));
    clickSave();
    await waitFor(() => {
      expect(agentMocks.createAgent).toHaveBeenCalledTimes(1);
    });
    expect(otherMocks.createKb).toHaveBeenCalledTimes(2);
    expect(otherMocks.createKb.mock.calls[1]?.[0]).toMatchObject({ name: "stock-lab-知识库-2" });
    const payload = agentMocks.createAgent.mock.calls[0]?.[0] as { kbWriteTargetId?: string };
    expect(payload.kbWriteTargetId).toBe("kb-new-2");
  });

  it("改名弹窗：重名本地拦截不发起请求；确认调用 updateKb 并即时生效", async () => {
    agentMocks.fetchAgent.mockResolvedValue(agentFixture);
    otherMocks.updateKb.mockResolvedValue(kbDTO({ id: "kb-own", name: "改名后的库", sourceAgentId: "ag-1" }));
    renderEditor("/agents/ag-1");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getByRole("button", { name: "改名" }));
    });
    fireEvent.click(within(kbField("独立知识库")).getByRole("button", { name: "改名" }));
    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByLabelText("知识库名称") as HTMLInputElement;
    expect(nameInput.value).toBe("own-agent-kb");
    // 重名：本人既有库内唯一，本地拦截
    fireEvent.change(nameInput, { target: { value: "普通共享库" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
    expect(await within(dialog).findByText(/已存在同名知识库/)).toBeInTheDocument();
    expect(otherMocks.updateKb).not.toHaveBeenCalled();
    // 改为合法名：确认调用 updateKb，弹窗关闭且行内名称即时更新
    fireEvent.change(nameInput, { target: { value: "改名后的库" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() => {
      expect(otherMocks.updateKb).toHaveBeenCalledWith("kb-own", { name: "改名后的库" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(within(kbField("独立知识库")).getByText("改名后的库")).toBeInTheDocument();
  });

  it("改名弹窗取消/关闭不生效", async () => {
    agentMocks.fetchAgent.mockResolvedValue(agentFixture);
    renderEditor("/agents/ag-1");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getByRole("button", { name: "改名" }));
    });
    fireEvent.click(within(kbField("独立知识库")).getByRole("button", { name: "改名" }));
    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByLabelText("知识库名称") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "未提交的名字" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(otherMocks.updateKb).not.toHaveBeenCalled();
    expect(within(kbField("独立知识库")).getByText("own-agent-kb")).toBeInTheDocument();
  });

  it("编辑态取消勾选独立知识库：目标清空且专有库从绑定摘除", async () => {
    agentMocks.fetchAgent.mockResolvedValue(agentFixture);
    agentMocks.updateAgent.mockResolvedValue(agentFixture);
    renderEditor("/agents/ag-1");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(1);
    });
    fireEvent.click(within(kbField("独立知识库")).getByRole("checkbox"));
    clickSave();
    await waitFor(() => {
      expect(agentMocks.updateAgent).toHaveBeenCalledTimes(1);
    });
    const payload = agentMocks.updateAgent.mock.calls[0]?.[1] as {
      kbWriteTargetId?: string | null;
      knowledgeBaseIds?: string[];
    };
    expect(payload.kbWriteTargetId ?? null).toBeNull();
    expect(payload.knowledgeBaseIds ?? []).not.toContain("kb-own");
  });

  it("编辑态重新勾选已有专有库：直接复用不重复建库", async () => {
    agentMocks.fetchAgent.mockResolvedValue({ ...agentFixture, knowledgeBaseIds: [], kbWriteTargetId: null });
    agentMocks.updateAgent.mockResolvedValue(agentFixture);
    renderEditor("/agents/ag-1");
    await waitFor(() => {
      expect(within(kbField("独立知识库")).getAllByRole("checkbox")).toHaveLength(1);
    });
    fireEvent.click(within(kbField("独立知识库")).getByRole("checkbox"));
    clickSave();
    await waitFor(() => {
      expect(agentMocks.updateAgent).toHaveBeenCalledTimes(1);
    });
    expect(otherMocks.createKb).not.toHaveBeenCalled();
    const payload = agentMocks.updateAgent.mock.calls[0]?.[1] as {
      kbWriteTargetId?: string;
      knowledgeBaseIds?: string[];
    };
    expect(payload.kbWriteTargetId).toBe("kb-own");
    expect(payload.knowledgeBaseIds).toContain("kb-own");
  });
});
