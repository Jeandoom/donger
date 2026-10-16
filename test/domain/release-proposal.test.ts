import { describe, expect, it } from "vitest";
import { parseReleaseProposal } from "../../src/domain/release-proposal.js";

const valid = '```donger-proposal\n{"v":1,"feedbackId":"fb-1","kind":"bugfix","testEvidence":"npm test 1063 绿"}\n```';

describe("parseReleaseProposal", () => {
  it("标准提案块解析成功（kind 缺省 bugfix）", () => {
    const body = `修复说明……\n\n${valid}`;
    const p = parseReleaseProposal(body);
    expect(p).toMatchObject({ v: 1, feedbackId: "fb-1", kind: "bugfix" });
  });

  it("MR 描述为空/无提案块 → undefined", () => {
    expect(parseReleaseProposal(undefined)).toBeUndefined();
    expect(parseReleaseProposal("普通 MR 描述，无块")).toBeUndefined();
  });

  it("JSON 非法 → undefined", () => {
    expect(parseReleaseProposal("```donger-proposal\n{broken\n```")).toBeUndefined();
  });

  it("schema 不符（缺 feedbackId / v 非 1）→ undefined", () => {
    expect(
      parseReleaseProposal('```donger-proposal\n{"v":1}\n```'),
    ).toBeUndefined();
    expect(
      parseReleaseProposal('```donger-proposal\n{"v":2,"feedbackId":"x"}\n```'),
    ).toBeUndefined();
  });

  it("嵌套在长描述中仍可提取（非贪婪到首个闭合围栏）", () => {
    const body = `## 动机\n某反馈……\n\n## 验证\n${valid}\n\n附加说明`;
    expect(parseReleaseProposal(body)?.feedbackId).toBe("fb-1");
  });
});
