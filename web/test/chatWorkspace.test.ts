import { fireEvent, render, screen, within } from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversationSidebarProps } from "../src/components/chat/AgentConversationSidebar";
import { ChatWorkspace } from "../src/components/chat/ChatWorkspace";

function sidebarProps(): AgentConversationSidebarProps {
  return {
    agents: [],
    conversations: [],
    activeConversationId: null,
    prefs: { starredAgentIds: [], agentOrder: [] },
    onPrefsChange: vi.fn(),
    onSelectConversation: vi.fn(),
    onDeleteConversation: vi.fn(),
    onNewConversation: vi.fn(),
  };
}

function renderWorkspace(overrides: Partial<ComponentProps<typeof ChatWorkspace>> = {}): void {
  render(
    createElement(ChatWorkspace, {
      conversations: [],
      activeConversationId: null,
      onSelectConversation: vi.fn(),
      onDeleteConversation: vi.fn(),
      sidebar: sidebarProps(),
      messages: [],
      loadingMessages: false,
      isGenerating: false,
      pendingApproval: null,
      pendingCredential: null,
      connection: "open",
      onSend: vi.fn().mockResolvedValue(undefined),
      onCancel: vi.fn().mockResolvedValue(undefined),
      onResolveApproval: vi.fn(),
      onSubmitCredential: vi.fn(),
      errors: {},
      onReloadConversations: vi.fn(),
      onReloadMessages: vi.fn(),
      ...overrides,
    }),
  );
}

describe("ChatWorkspace", () => {
  it("renders the shared conversation and composer workspace", () => {
    renderWorkspace();

    // 顶部「+ 新会话」已移除：新建会话唯一入口是各智能体分组的「+」
    expect(screen.queryByRole("button", { name: "+ 新会话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加内容" })).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
  });

  it("➕ 菜单：闲聊会话只提供附件入口，绑定智能体后才出现引用项", () => {
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "添加内容" }));
    expect(screen.getByRole("menuitem", { name: /添加附件/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /引用技能/ })).not.toBeInTheDocument();
  });

  it("shows the assistant-ui welcome state before the first message", () => {
    renderWorkspace();

    expect(screen.getByRole("heading", { name: "开始新的会话" })).toBeInTheDocument();
    expect(screen.getByText("发送消息或添加附件，开始一个新的任务。")).toBeInTheDocument();
  });

  it("presents user and assistant messages as distinct role rows", () => {
    renderWorkspace({
      messages: [
        { id: "u1", role: "user", text: "检查服务" },
        { id: "a1", role: "bot", text: "服务运行正常" },
      ],
    });

    expect(screen.getByLabelText("用户消息")).toHaveTextContent("检查服务");
    expect(screen.getByLabelText("助手消息")).toHaveTextContent("服务运行正常");
    expect(screen.getByText("你")).toBeInTheDocument();
    expect(screen.getByText("donger")).toBeInTheDocument();
  });

  it("hides the welcome state while an interaction card is pending", () => {
    renderWorkspace({
      pendingApproval: { gateId: "g1", title: "部署审批", summary: "运行 deploy" },
    });

    expect(screen.queryByRole("heading", { name: "开始新的会话" })).not.toBeInTheDocument();
    expect(screen.getByText("部署审批")).toBeInTheDocument();
  });

  it("shows a thinking indicator while the assistant is generating", () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({ isGenerating: true, onCancel });

    expect(screen.getByRole("status", { name: "思考中" })).toBeInTheDocument();
    expect(screen.getByLabelText("助手消息")).toHaveTextContent("donger");
    expect(screen.getByLabelText("助手消息")).toHaveTextContent("思考中");
    expect(screen.getAllByLabelText("助手消息")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "停止输出" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "发送消息" })).not.toBeInTheDocument();
  });

  it("hides the thinking indicator after the first assistant text arrives", () => {
    renderWorkspace({
      isGenerating: true,
      messages: [
        { id: "u1", role: "user", text: "hi" },
        { id: "a1", role: "bot", text: "你" },
      ],
    });

    expect(screen.queryByRole("status", { name: "思考中" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("助手消息")).toHaveTextContent("donger");
    expect(screen.getByLabelText("助手消息")).toHaveTextContent("你");
  });

  it("keeps the mobile composer inside the safe area with touch-sized controls", () => {
    renderWorkspace();

    const addContent = screen.getByRole("button", { name: "添加内容" });
    expect(addContent).toHaveClass("min-h-11");
    const composer = screen.getByRole("form", { name: "消息输入" });
    expect(composer).toHaveClass("pb-safe", "rounded-2xl", "shadow-sm");
    expect(screen.getByRole("button", { name: "发送消息" })).toHaveClass("min-h-11", "min-w-11");
  });

  it("renders scoped recovery actions", () => {
    const onReloadConversations = vi.fn();
    const onReloadMessages = vi.fn();
    render(
      createElement(ChatWorkspace, {
        conversations: [],
        activeConversationId: null,
        onSelectConversation: vi.fn(),
        onDeleteConversation: vi.fn(),
        sidebar: sidebarProps(),
        messages: [],
        loadingMessages: false,
        isGenerating: false,
        pendingApproval: null,
        pendingCredential: null,
        connection: "closed",
        onSend: vi.fn().mockResolvedValue(undefined),
        onCancel: vi.fn().mockResolvedValue(undefined),
        onResolveApproval: vi.fn(),
        onSubmitCredential: vi.fn(),
        errors: {
          stream: "连接中断，浏览器正在自动重连",
          messages: "历史消息加载失败",
          conversations: "会话列表加载失败",
        },
        onReloadConversations,
        onReloadMessages,
      }),
    );

    expect(screen.getByRole("status")).toHaveTextContent("连接中断");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    fireEvent.click(screen.getByRole("button", { name: "重新加载会话" }));
    expect(onReloadMessages).toHaveBeenCalledTimes(1);
    expect(onReloadConversations).toHaveBeenCalledTimes(1);
  });

  it("顶栏显示 Agent SDK 标识：选中模型的引擎优先，未选模型退回会话上次引擎", () => {
    const conversation = {
      id: "c1",
      userId: "u1",
      sdkSessionId: "",
      title: "会话一",
      channelId: "web",
      agentId: "",
      llmSdkType: "openai" as const,
      createdAt: "",
      updatedAt: "",
      archived: false,
    };
    const modelOptions = [
      { ref: "system", label: "系统默认（m）", sdkType: "anthropic" as const },
      { ref: "provider:p2:deepseek-chat", label: "DS / deepseek-chat", sdkType: "openai" as const },
    ];
    // 未显式选模型 → 显示会话上次运行引擎
    const { rerender } = render(
      createElement(ChatWorkspace, {
        conversations: [conversation],
        activeConversationId: "c1",
        modelOptions,
        modelRef: "",
        onModelRefChange: vi.fn(),
        onSelectConversation: vi.fn(),
        onDeleteConversation: vi.fn(),
        sidebar: sidebarProps(),
        messages: [],
        loadingMessages: false,
        isGenerating: false,
        pendingApproval: null,
        pendingCredential: null,
        connection: "open",
        onSend: vi.fn().mockResolvedValue(undefined),
        onCancel: vi.fn().mockResolvedValue(undefined),
        onResolveApproval: vi.fn(),
        onSubmitCredential: vi.fn(),
        errors: {},
        onReloadConversations: vi.fn(),
        onReloadMessages: vi.fn(),
      }),
    );
    expect(screen.getByText("Codex Agent SDK")).toBeInTheDocument();

    // 选中 system（Claude Code 引擎）→ 徽标即时切换
    rerender(
      createElement(ChatWorkspace, {
        conversations: [conversation],
        activeConversationId: "c1",
        modelOptions,
        modelRef: "system",
        onModelRefChange: vi.fn(),
        onSelectConversation: vi.fn(),
        onDeleteConversation: vi.fn(),
        sidebar: sidebarProps(),
        messages: [],
        loadingMessages: false,
        isGenerating: false,
        pendingApproval: null,
        pendingCredential: null,
        connection: "open",
        onSend: vi.fn().mockResolvedValue(undefined),
        onCancel: vi.fn().mockResolvedValue(undefined),
        onResolveApproval: vi.fn(),
        onSubmitCredential: vi.fn(),
        errors: {},
        onReloadConversations: vi.fn(),
        onReloadMessages: vi.fn(),
      }),
    );
    expect(screen.getByText("Claude Code SDK")).toBeInTheDocument();
    expect(screen.queryByText("Codex Agent SDK")).not.toBeInTheDocument();
  });

  it("草稿/未运行过的会话不显示 Agent SDK 标识", () => {
    renderWorkspace();
    expect(screen.queryByText("Claude Code SDK")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex Agent SDK")).not.toBeInTheDocument();
    expect(screen.queryByText("ZCode CLI")).not.toBeInTheDocument();
  });
});

describe("对话内反馈入口与会话 ID 复制（spec 2026-10-01-chat-feedback-entry-design）", () => {
  const conversation = {
    id: "conv-abc12345",
    userId: "u1",
    sdkSessionId: "",
    title: "排障会话",
    channelId: "web",
    agentId: "",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    archived: false,
  };

  it("非草稿会话显示复制会话 ID 按钮，点击写入剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWorkspace({ conversations: [conversation], activeConversationId: conversation.id });

    fireEvent.click(screen.getByRole("button", { name: "复制会话 ID" }));
    expect(writeText).toHaveBeenCalledWith(conversation.id);
    // 已复制态在剪贴板 promise 兑现后切换（微任务），用 findBy 等待
    expect(await screen.findByRole("button", { name: "会话 ID 已复制" })).toBeInTheDocument();
  });

  it("草稿会话隐藏复制按钮，反馈入口禁用并提示先发首条消息", () => {
    renderWorkspace({ activeConversationIsDraft: true });

    expect(screen.queryByRole("button", { name: "复制会话 ID" })).not.toBeInTheDocument();
    const feedbackButton = screen.getByRole("button", { name: "反馈" });
    expect(feedbackButton).toBeDisabled();
    expect(feedbackButton).toHaveAttribute("title", "发送首条消息后可对此会话提交反馈");
  });

  it("反馈弹窗预填当前会话作为关联对话记录，可移除更换", () => {
    renderWorkspace({ conversations: [conversation], activeConversationId: conversation.id });

    fireEvent.click(screen.getByRole("button", { name: "反馈" }));
    const dialog = within(screen.getByRole("dialog", { name: "提交反馈" }));
    // 关联会话 chip 预填当前会话（标题同时出现在顶栏，须在弹窗内断言）
    expect(dialog.getByText("排障会话")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "移除关联会话" })).toBeInTheDocument();
  });
});
