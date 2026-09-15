import { describe, expect, it } from "vitest";
import { assembleQuestionAnswers } from "./questionCard";

describe("assembleQuestionAnswers", () => {
  const questions = [
    { question: "异常表现是什么？", options: [{ label: "接口报错" }, { label: "超时" }] },
    { question: "补充线索？", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ];

  it("单选取 label；「其他」文本优先并作为 response", () => {
    const { answers, response } = assembleQuestionAnswers(
      questions,
      { "异常表现是什么？": ["接口报错"], "补充线索？": ["A"] },
      { "异常表现是什么？": "只知道有异常" },
    );
    expect(answers["异常表现是什么？"]).toBe("只知道有异常");
    expect(answers["补充线索？"]).toBe("A");
    expect(response).toBe("只知道有异常");
  });

  it("多选拼逗号串；未作答问题不出现", () => {
    const { answers, response } = assembleQuestionAnswers(
      questions,
      { "补充线索？": ["A", "B"] },
      {},
    );
    expect(answers["补充线索？"]).toBe("A, B");
    expect("异常表现是什么？" in answers).toBe(false);
    expect(response).toBe("");
  });

  it("全未作答返回空 answers", () => {
    const { answers } = assembleQuestionAnswers(questions, {}, {});
    expect(answers).toEqual({});
  });
});
