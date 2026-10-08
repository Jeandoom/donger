import { describe, expect, it } from "vitest";
import { isSessionExpiredError } from "../../src/orchestrator/session-expiry.js";

describe("isSessionExpiredError（契约 §C3：会话不可恢复识别）", () => {
  it("claude 文案命中", () => {
    expect(isSessionExpiredError("No conversation found with session ID abc-123")).toBe(true);
  });

  it("zcode 文案命中（2026-10-08 事故原文形状）", () => {
    expect(
      isSessionExpiredError("Session not found: sess_a0e22200-471b-4a53-9074-df9cb65800fc"),
    ).toBe(true);
  });

  it("其他错误不命中（防误清指针）", () => {
    expect(isSessionExpiredError("ZCode session/send 被拒绝")).toBe(false);
    expect(isSessionExpiredError("provider_not_found")).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
    expect(isSessionExpiredError("")).toBe(false);
  });
});
