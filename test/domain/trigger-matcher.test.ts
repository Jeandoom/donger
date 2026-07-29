import { describe, expect, it } from "vitest";
import { evaluateMatcher } from "../../src/domain/trigger-matcher.js";

const ctx = (body: string, httpStatus = 200, headers: Record<string, string> = {}) => ({
  body,
  httpStatus,
  headers,
});

describe("evaluateMatcher", () => {
  it("always matches", () => {
    expect(evaluateMatcher({ kind: "always" }, ctx("anything")).matched).toBe(true);
  });

  it("statusEq", () => {
    expect(evaluateMatcher({ kind: "statusEq", value: 200 }, ctx("x", 200)).matched).toBe(true);
    expect(evaluateMatcher({ kind: "statusEq", value: 200 }, ctx("x", 500)).matched).toBe(false);
  });

  it("bodyContains", () => {
    expect(
      evaluateMatcher({ kind: "bodyContains", keyword: "error" }, ctx("server error")).matched,
    ).toBe(true);
    expect(
      evaluateMatcher({ kind: "bodyContains", keyword: "ok" }, ctx("server error")).matched,
    ).toBe(false);
  });

  it("bodyRegex", () => {
    expect(
      evaluateMatcher({ kind: "bodyRegex", pattern: "v\\d+\\.\\d+" }, ctx("released v2.4")).matched,
    ).toBe(true);
  });

  it("jsonPathEq via simple dot path", () => {
    expect(
      evaluateMatcher({ kind: "jsonPathEq", path: "$.status", value: "ok" }, ctx('{"status":"ok"}'))
        .matched,
    ).toBe(true);
  });

  it("jsonPathGt", () => {
    expect(
      evaluateMatcher({ kind: "jsonPathGt", path: "$.count", value: 10 }, ctx('{"count":42}'))
        .matched,
    ).toBe(true);
    expect(
      evaluateMatcher({ kind: "jsonPathGt", path: "$.count", value: 10 }, ctx('{"count":5}'))
        .matched,
    ).toBe(false);
  });

  it("bodyFieldEq on JSON body", () => {
    expect(
      evaluateMatcher(
        { kind: "bodyFieldEq", field: "type", value: "issue" },
        ctx('{"type":"issue"}'),
      ).matched,
    ).toBe(true);
  });

  it("headerEq", () => {
    expect(
      evaluateMatcher(
        { kind: "headerEq", header: "x-signature", value: "abc" },
        ctx("", 200, { "x-signature": "abc" }),
      ).matched,
    ).toBe(true);
  });

  it("returns error on malformed JSON for jsonPath", () => {
    const r = evaluateMatcher({ kind: "jsonPathEq", path: "$.x", value: "y" }, ctx("not json"));
    expect(r.matched).toBe(false);
    expect(r.error).toMatch(/json/i);
  });

  it("returns error on invalid regex", () => {
    const r = evaluateMatcher({ kind: "bodyRegex", pattern: "(" }, ctx("foo"));
    expect(r.matched).toBe(false);
    expect(r.error).toMatch(/regex/i);
  });
});
