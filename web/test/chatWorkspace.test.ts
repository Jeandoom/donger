import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "../src/components/chat/ChatWorkspace";

describe("ChatWorkspace", () => {
  it("renders the shared conversation and composer workspace", () => {
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
        pendingApproval: null,
        pendingCredential: null,
        connection: "open",
        onSend: vi.fn().mockResolvedValue(undefined),
        onResolveApproval: vi.fn(),
        onSubmitCredential: vi.fn(),
        errors: {},
        onReloadConversations: vi.fn(),
        onReloadMessages: vi.fn(),
      }),
    );

    expect(screen.getByText("会话（0）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeInTheDocument();
    expect(screen.getByText("● 已连接")).toBeInTheDocument();
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
