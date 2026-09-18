import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentConversationSidebar } from "../src/components/chat/AgentConversationSidebar";
import type { AgentListDTO } from "../src/lib/agents";
import type { SidebarPrefs } from "../src/lib/agentSidebar";
import type { ConversationSummary } from "../src/types";
import { FileBrowserDrawer } from "../src/components/files/FileBrowserDrawer";

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

function conv(id: string, agentId: string, title: string): ConversationSummary {
  return {
    id,
    userId: "u",
    sdkSessionId: "",
    title,
    channelId: "web",
    agentId,
    createdAt: "2026-09-18T10:00:00Z",
    updatedAt: "2026-09-18T10:00:00Z",
    archived: false,
  };
}

const prefs: SidebarPrefs = { starredAgentIds: [], agentOrder: ["a1"] };

describe("mobile interactions", () => {
  it("gives each conversation delete action an explicit accessible name", () => {
    render(
      createElement(AgentConversationSidebar, {
        agents: [agentDto("a1", "分析助手")],
        conversations: [conv("c1", "a1", "第一条")],
        activeConversationId: null,
        prefs,
        onPrefsChange: vi.fn(),
        onSelectConversation: vi.fn(),
        onDeleteConversation: vi.fn(),
        onNewConversation: vi.fn(),
      }),
    );

    expect(screen.getByRole("button", { name: "删除会话：第一条" })).toBeInTheDocument();
  });

  it("exposes the file drawer as a modal dialog", () => {
    const { container } = render(
      createElement(FileBrowserDrawer, {
        open: false,
        onClose: vi.fn(),
        activeConversationId: null,
      }),
    );

    // 关闭态：抽屉仍为 dialog 且对辅助技术隐藏（不可 Tab 聚焦到不可见控件）
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-hidden", "true");
    // 关闭态下抽屉内不应有可聚焦控件
    const focusables = dialog.querySelectorAll("button, [tabindex]");
    for (const el of focusables) {
      expect(el.closest('[aria-hidden="true"]')).toBe(dialog);
    }
  });
});
