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
    render(
      createElement(FileBrowserDrawer, {
        open: false,
        onClose: vi.fn(),
        activeConversationId: null,
      }),
    );

    expect(screen.getByRole("dialog", { name: "文件浏览", hidden: true })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });
});
