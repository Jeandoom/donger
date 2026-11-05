import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationSidebarProps } from "../src/components/chat/ConversationSidebar";
import { MobileConversationSheet } from "../src/components/chat/MobileConversationSheet";
import type { SidebarPrefs } from "../src/lib/agentSidebar";
import type { AgentListDTO } from "../src/lib/agents";
import type { ConversationSummary } from "../src/types";

function agentDto(id: string, name: string): AgentListDTO {
  return {
    id,
    ownerId: "",
    _mine: true,
    name,
    skills: [],
    tools: { mode: "whitelist", whitelist: [] },
    mcpServers: [],
    llm: {},
    createdAt: "",
    updatedAt: "",
  };
}

const prefs: SidebarPrefs = { starredAgentIds: [], agentOrder: ["a1"] };

function sidebarProps(
  onSelect: ReturnType<typeof vi.fn>,
  onNew: ReturnType<typeof vi.fn>,
): ConversationSidebarProps {
  const first: ConversationSummary = {
    id: "c1",
    userId: "u",
    sdkSessionId: "",
    title: "第一条",
    channelId: "web",
    agentId: "a1",
    createdAt: "2026-09-18T10:00:00Z",
    updatedAt: "2026-09-18T10:00:00Z",
    archived: false,
  };
  return {
    agents: [agentDto("a1", "分析助手")],
    conversations: [first],
    activeConversationId: null,
    prefs,
    onPrefsChange: vi.fn(),
    onSelectConversation: onSelect,
    onDeleteConversation: vi.fn(),
    onNewConversation: onNew,
  };
}

describe("MobileConversationSheet", () => {
  it("closes after selecting a conversation and restores focus", () => {
    const onSelect = vi.fn();
    render(
      createElement(MobileConversationSheet, {
        sidebar: sidebarProps(onSelect, vi.fn()),
      }),
    );
    const trigger = screen.getByRole("button", { name: "打开历史会话" });
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "打开会话：第一条" }));
    expect(onSelect).toHaveBeenCalledWith("c1");
    expect(screen.queryByRole("dialog", { name: "历史会话" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });

  it("closes after creating a conversation", () => {
    const onNew = vi.fn();
    render(
      createElement(MobileConversationSheet, {
        sidebar: sidebarProps(vi.fn(), onNew),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开历史会话" }));
    // 新侧栏新建流：右上「新建会话」→ agent 选择菜单 → 点选智能体（chat UE 轮扁平化）
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /分析助手/ }));
    expect(onNew).toHaveBeenCalledWith("a1");
    expect(screen.queryByRole("dialog", { name: "历史会话" })).not.toBeInTheDocument();
  });
});
