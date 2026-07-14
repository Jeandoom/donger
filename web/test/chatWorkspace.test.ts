import { render, screen } from "@testing-library/react";
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
      }),
    );

    expect(screen.getByText("会话（0）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeInTheDocument();
    expect(screen.getByText("● 已连接")).toBeInTheDocument();
  });
});
