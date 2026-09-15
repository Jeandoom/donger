import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWebChat } from "../src/lib/webChat";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useWebChat conversation switching", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not let an old history response replace the active conversation", async () => {
    const firstHistory = deferredResponse();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/conversations?")) {
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        if (url.includes('/c1/events') || url.includes('/c2/events')) {
          return Promise.resolve(new Response(JSON.stringify({ events: [] }), { status: 200 }));
        }
        if (url.endsWith('/pending-question')) {
          return Promise.resolve(new Response(JSON.stringify({ question: null }), { status: 200 }));
        }
        if (url.includes("/c1/messages")) return firstHistory.promise;
        if (url.includes("/c2/messages")) {
          return Promise.resolve(
            new Response(JSON.stringify([{ id: "m2", role: "bot", text: "second" }]), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { result } = renderHook(() => useWebChat());
    act(() => result.current.switchConversation("c1"));
    act(() => result.current.switchConversation("c2"));
    await waitFor(() => expect(result.current.messages[0]?.id).toBe("turn-m2"));
    firstHistory.resolve(
      new Response(JSON.stringify([{ id: "m1", role: "bot", text: "first" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await act(async () => Promise.resolve());
    expect(result.current.messages[0]?.id).toBe("turn-m2");
  });
});
