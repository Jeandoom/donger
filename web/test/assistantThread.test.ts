import { render, screen } from "@testing-library/react";
import { createElement } from "react";
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

  it("renders scoped approval and credential errors inside their cards", () => {
    render(
      createElement(PendingInteraction, {
        approval: { gateId: "g1", title: "部署审批", summary: "运行 deploy" },
        credential: {
          reqId: "r1",
          items: [{ key: "TOKEN", label: "令牌", secret: true, packName: "deploy" }],
        },
        approvalError: "审批提交失败",
        credentialError: "凭证提交失败",
        onResolveApproval: vi.fn(),
        onSubmitCredential: vi.fn(),
      }),
    );

    expect(screen.getByText("审批提交失败")).toHaveAttribute("role", "alert");
    expect(screen.getByText("凭证提交失败")).toHaveAttribute("role", "alert");
  });
});
