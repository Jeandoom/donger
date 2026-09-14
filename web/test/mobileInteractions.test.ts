import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { FileBrowserDrawer } from "../src/components/files/FileBrowserDrawer";
import { SecondarySidebar } from "../src/components/layout/SecondarySidebar";

describe("mobile interactions", () => {
  it("gives each conversation delete action an explicit accessible name", () => {
    render(
      createElement(SecondarySidebar, {
        title: "会话",
        items: [{ id: "c1", title: "第一条" }],
        selectedId: null,
        onItemClick: vi.fn(),
        onItemDelete: vi.fn(),
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
