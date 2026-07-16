import { describe, expect, it } from "vitest";
import { contentUrl } from "../src/lib/files";

describe("contentUrl", () => {
  it("拼接 scope/path/token，不含 download", () => {
    const u = contentUrl({ scope: "user", path: ".skills/SKILL.md", token: "abc" });
    expect(u).toBe("/api/files/content?scope=user&path=.skills%2FSKILL.md&token=abc");
  });

  it("runtime 带 conversationId", () => {
    const u = contentUrl({
      scope: "runtime",
      path: "a.png",
      conversationId: "c1",
      token: "t",
    });
    expect(u).toContain("scope=runtime");
    expect(u).toContain("conversationId=c1");
    expect(u).toContain("path=a.png");
  });

  it("download=1 追加 download 参数", () => {
    const u = contentUrl({ scope: "user", path: "x.md", token: "t", download: true });
    expect(u).toContain("download=1");
  });

  it("extension scope 携带 conversationId", () => {
    const u = contentUrl({
      scope: "extension",
      path: "docs/readme.md",
      conversationId: "c1",
      token: "t",
    });
    expect(u).toContain("scope=extension");
    expect(u).toContain("conversationId=c1");
  });
});
