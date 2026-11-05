import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConversationSidebar } from "../src/components/chat/ConversationSidebar";
import { FileBrowserDrawer } from "../src/components/files/FileBrowserDrawer";
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
  it("gives each conversation row action an explicit accessible name", () => {
    render(
      createElement(ConversationSidebar, {
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

    // chat UE 轮 E1-C：删除语义=移入归档（可恢复），触屏可达（reveal-hover 恒显于 coarse 指针）
    expect(screen.getByRole("button", { name: "归档会话：第一条" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重命名会话：第一条" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开会话：第一条" })).toBeInTheDocument();
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
