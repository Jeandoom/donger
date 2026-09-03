import { describe, expect, it } from "vitest";
import { errorKind } from "../src/api.js";
import { autoApprovalResponse, emptyCredentialValues, nextBackoffMs } from "../src/session.js";

describe("nextBackoffMs", () => {
  it("指数退避 1s 起步，30s 封顶", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(nextBackoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it("非法 attempt（0/负数）按第 1 次处理", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(-3)).toBe(1000);
  });
});

describe("非交互安全默认", () => {
  it("审批自动驳回并带原因", () => {
    expect(autoApprovalResponse()).toEqual({
      approved: false,
      reason: "非交互模式自动驳回",
    });
  });

  it("凭证提交空值（键位齐全）", () => {
    expect(
      emptyCredentialValues([
        { key: "token", label: "令牌", secret: true },
        { key: "region", label: "区域", secret: false },
      ]),
    ).toEqual({ token: "", region: "" });
  });
});

describe("errorKind", () => {
  it("401/403 → auth，5xx → server，其余 → client", () => {
    expect(errorKind(401)).toBe("auth");
    expect(errorKind(403)).toBe("auth");
    expect(errorKind(500)).toBe("server");
    expect(errorKind(503)).toBe("server");
    expect(errorKind(400)).toBe("client");
    expect(errorKind(404)).toBe("client");
    expect(errorKind(428)).toBe("client");
  });
});
