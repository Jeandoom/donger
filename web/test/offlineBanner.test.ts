import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { OfflineBanner } from "../src/components/pwa/OfflineBanner";

describe("OfflineBanner", () => {
  it("shows a network-only message after the browser goes offline", () => {
    render(createElement(OfflineBanner));
    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByRole("status")).toHaveTextContent("当前离线，聊天功能需要联网");
  });
});
