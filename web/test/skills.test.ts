import { describe, expect, it } from "vitest";
import { credentialStatus } from "../src/lib/skills";

describe("credentialStatus", () => {
  it("区分已配/缺失", () => {
    const pack = {
      credentials: [
        { key: "A", label: "A", configured: true, required: true, secret: true },
        { key: "B", label: "B", configured: false, required: true, secret: true },
      ],
    };
    expect(credentialStatus(pack)).toEqual({ configured: ["A"], missing: ["B"] });
  });

  it("空 credentials → 都为空", () => {
    expect(credentialStatus({ credentials: [] })).toEqual({ configured: [], missing: [] });
  });
});
