import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatReducer, initialChatState } from "../src/lib/chatReducer";
import { useWebChat } from "../src/lib/webChat";

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor() {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close(): void {}
}

describe("chat errors", () => {
  afterEach(() => {
    FakeEventSource.latest = null;
    vi.unstubAllGlobals();
  });

  it("stores and clears a scoped error", () => {
    const failed = chatReducer(initialChatState(), {
      type: "set_error",
      key: "messages",
      message: "历史消息加载失败",
    });
    expect(failed.errors.messages).toBe("历史消息加载失败");
    const cleared = chatReducer(failed, { type: "clear_error", key: "messages" });
    expect(cleared.errors.messages).toBeUndefined();
  });

  it("surfaces conversation-list and history failures", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/conversations?")) {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        if (url.includes("/c1/messages")) {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { result } = renderHook(() => useWebChat());
    await waitFor(() => expect(result.current.errors.conversations).toBe("HTTP 500"));
    act(() => result.current.switchConversation("c1"));
    await waitFor(() => expect(result.current.errors.messages).toBe("HTTP 503"));
  });

  it("reports stream and approval failures without removing the approval card", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/conversations?")) {
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        if (url.includes("/c1/messages")) {
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        if (url.includes("/api/approvals/g1/respond")) {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { result } = renderHook(() => useWebChat());
    act(() => result.current.switchConversation("c1"));
    await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    act(() => {
      FakeEventSource.latest?.emit("approval_card", {
        type: "approval_card",
        gateId: "g1",
        title: "部署",
        summary: "上线",
      });
    });
    await waitFor(() => expect(result.current.pendingApproval?.gateId).toBe("g1"));
    await act(async () => result.current.resolveApproval(true));
    expect(result.current.pendingApproval?.gateId).toBe("g1");
    expect(result.current.errors.approval).toBe("HTTP 500");

    act(() => FakeEventSource.latest?.onerror?.());
    expect(result.current.connection).toBe("closed");
    expect(result.current.errors.stream).toContain("自动重连");
  });
});
