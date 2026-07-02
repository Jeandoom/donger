import { describe, expect, it } from "vitest";
import { formatDurationMs, formatTokens } from "../src/lib/audit";

describe("formatDurationMs", () => {
  it("undefined → '—'", () => {
    expect(formatDurationMs(undefined)).toBe("—");
  });
  it("<1000 → 'Nms'", () => {
    expect(formatDurationMs(42)).toBe("42ms");
  });
  it(">=1000 → 'N.Ns'", () => {
    expect(formatDurationMs(1200)).toBe("1.2s");
  });
  it(">=60000 → 'Nm Ns'", () => {
    expect(formatDurationMs(65000)).toBe("1m 5s");
  });
});

describe("formatTokens", () => {
  it("0 → '0'", () => {
    expect(formatTokens(0)).toBe("0");
  });
  it("1500 → '1.5k'", () => {
    expect(formatTokens(1500)).toBe("1.5k");
  });
  it("偏大的负值兜底（undefined）→ '—'", () => {
    expect(formatTokens(undefined)).toBe("—");
  });
});
