import { fireEvent, render, screen } from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "../src/components/chat/ChatWorkspace";

function renderWorkspace(overrides: Partial<ComponentProps<typeof ChatWorkspace>> = {}): void {
  render(
    createElement(ChatWorkspace, {
      conversations: [],
      activeConversationId: null,
      onSelectConversation: vi.fn(),
      onDeleteConversation: vi.fn(),
      onNewConversation: vi.fn(),
      sidebarTitle: "会话（0）",
      messages: [],
      loadingMessages: false,
      isGenerating: false,
      pendingApproval: null,
      pendingCredential: null,
      connection: "open",
      onSend: vi.fn().mockResolvedValue(undefined),
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

    expect(screen.getByText("会话（0）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeInTheDocument();
    expect(screen.getByText("● 已连接")).toBeInTheDocument();
  });

  it("shows the assistant-ui welcome state before the first message", () => {
    renderWorkspace();

    expect(screen.getByRole("heading", { name: "开始新的对话" })).toBeInTheDocument();
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

    expect(screen.queryByRole("heading", { name: "开始新的对话" })).not.toBeInTheDocument();
    expect(screen.getByText("部署审批")).toBeInTheDocument();
  });

  it("shows a thinking indicator while the assistant is generating", () => {
    renderWorkspace({ isGenerating: true });

    expect(screen.getByRole("status", { name: "思考中" })).toBeInTheDocument();
  });

  it("keeps the mobile composer inside the safe area with touch-sized controls", () => {
    renderWorkspace({ sidebarTitle: "会话" });

    const addAttachment = screen.getByRole("button", { name: "添加附件" });
    expect(addAttachment).toHaveClass("min-h-11");
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
        onNewConversation: vi.fn(),
        sidebarTitle: "会话",
        messages: [],
        loadingMessages: false,
        isGenerating: false,
        pendingApproval: null,
        pendingCredential: null,
        connection: "closed",
        onSend: vi.fn().mockResolvedValue(undefined),
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
