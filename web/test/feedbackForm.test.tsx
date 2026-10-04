import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackForm } from "../src/components/feedback/FeedbackForm";
import { type FeedbackItem, createFeedback, fetchConversationCandidates } from "../src/lib/feedback";

vi.mock("../src/lib/feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/feedback")>()),
  createFeedback: vi.fn(),
  fetchConversationCandidates: vi.fn(),
}));

const candidate = {
  id: "conv-abc12345",
  title: "排障会话",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

function renderForm(overrides: Partial<ComponentProps<typeof FeedbackForm>> = {}): void {
  render(
    createElement(FeedbackForm, {
      onCreated: vi.fn(),
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFeedback).mockResolvedValue({ id: "fb-1" } as FeedbackItem);
  vi.mocked(fetchConversationCandidates).mockResolvedValue({ items: [], total: 0 });
});

describe("FeedbackForm（反馈页/对话内弹窗共用表单）", () => {
  it("initialConversation 预填关联会话 chip，提交时随 payload 上送 conversationIds", async () => {
    const onCreated = vi.fn();
    render(
      createElement(FeedbackForm, { onCreated, initialConversation: candidate }),
    );

    expect(screen.getByText("排障会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除关联会话" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/描述你遇到的问题/), {
      target: { value: "按钮错位" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));

    await waitFor(() => {
      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ content: "按钮错位", conversationIds: ["conv-abc12345"] }),
      );
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("移除预填会话后提交不再携带 conversationIds", async () => {
    render(
      createElement(FeedbackForm, { onCreated: vi.fn(), initialConversation: candidate }),
    );

    fireEvent.click(screen.getByRole("button", { name: "移除关联会话" }));
    fireEvent.change(screen.getByPlaceholderText(/描述你遇到的问题/), {
      target: { value: "文案建议" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));

    await waitFor(() => {
      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ conversationIds: undefined }),
      );
    });
  });

  it("无预填时展示选择入口，打开选择器可回填本人会话候选", async () => {
    vi.mocked(fetchConversationCandidates).mockResolvedValue({
      items: [{ id: "c2", title: "另一会话", updatedAt: candidate.updatedAt }],
      total: 1,
    });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: /选择对话记录/ }));
    await waitFor(() => {
      expect(fetchConversationCandidates).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByRole("button", { name: /另一会话/ }));
    expect(screen.getByText("另一会话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /选择对话记录/ })).not.toBeInTheDocument();
  });
});
