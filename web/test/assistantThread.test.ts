import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PendingInteraction } from "../src/components/chat/PendingInteraction";

describe("PendingInteraction", () => {
  it("renders approval controls", () => {
    render(
      createElement(PendingInteraction, {
        approval: { gateId: "g1", title: "部署审批", summary: "运行 deploy" },
        credential: null,
        onResolveApproval: vi.fn(),
        onSubmitCredential: vi.fn(),
      }),
    );
    expect(screen.getByText("部署审批")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通过" })).toBeInTheDocument();
  });
});
