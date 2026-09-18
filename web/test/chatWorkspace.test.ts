import { fireEvent, render, screen } from "@testing-library/react";
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

    expect(screen.getByRole("button", { name: "+ 新会话" })).toBeDisabled();
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
});
