import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "../src/components/pwa/OfflineBanner";

const okResponse = () => new Response(null, { status: 200 });
const networkError = () => new TypeError("Failed to fetch");

function setNavigatorOnLine(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

describe("OfflineBanner", () => {
  const originalOnLine =
    Object.getOwnPropertyDescriptor(window.navigator, "onLine") ??
    Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalOnLine) Object.defineProperty(window.navigator, "onLine", originalOnLine);
  });

  it("浏览器误报离线但探测可达时不展示横幅", async () => {
    setNavigatorOnLine(false);
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(OfflineBanner));
    await act(async () => {});

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("offline 事件且探测失败时展示横幅", async () => {
    setNavigatorOnLine(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError()));

    render(createElement(OfflineBanner));
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(screen.getByRole("status")).toHaveTextContent("当前离线，聊天功能需要联网");
  });

  it("横幅展示期间复测成功后自动消失", async () => {
    setNavigatorOnLine(true);
    const fetchMock = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(OfflineBanner));
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("online 事件立即恢复并停止复测", async () => {
    setNavigatorOnLine(true);
    const fetchMock = vi.fn().mockRejectedValue(networkError());
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(OfflineBanner));
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const callsAfterRecovery = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterRecovery);
  });
});
