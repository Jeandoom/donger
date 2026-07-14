import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MobileConversationSheet } from "../src/components/chat/MobileConversationSheet";

describe("MobileConversationSheet", () => {
  it("closes after selecting a conversation and restores focus", () => {
    const onSelect = vi.fn();
    render(
      createElement(MobileConversationSheet, {
        title: "会话",
        items: [{ id: "c1", title: "第一条" }],
        selectedId: null,
        onSelect,
        onDelete: vi.fn(),
        onNew: vi.fn(),
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
        title: "会话",
        items: [],
        selectedId: null,
        onSelect: vi.fn(),
        onDelete: vi.fn(),
        onNew,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开历史会话" }));
    fireEvent.click(screen.getByRole("button", { name: /新会话/ }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "历史会话" })).not.toBeInTheDocument();
  });
});
