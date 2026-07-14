import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MobileNavigationDrawer } from "../src/components/layout/MobileNavigationDrawer";

describe("MobileNavigationDrawer", () => {
  it("opens, closes, locks scrolling, and restores trigger focus", () => {
    render(createElement(MemoryRouter, null, createElement(MobileNavigationDrawer)));
    const trigger = screen.getByRole("button", { name: "打开主导航" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "主导航" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "关闭主导航" }));
    expect(screen.queryByRole("dialog", { name: "主导航" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });
});
