import { describe, expect, it } from "vitest";
import { assembleQuestionAnswers, isQuestionAnswered, questionTabLabel } from "./questionCard";

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

describe("isQuestionAnswered", () => {
  const q = { question: "有 traceId 吗？", options: [{ label: "没有" }] };

  it("「其他」文本非空即已答（空白算未答）", () => {
    expect(isQuestionAnswered(q, {}, { [q.question]: "abc123" })).toBe(true);
    expect(isQuestionAnswered(q, {}, { [q.question]: "   " })).toBe(false);
  });

  it("选中任一选项即已答；都为空未答", () => {
    expect(isQuestionAnswered(q, { [q.question]: ["没有"] }, {})).toBe(true);
    expect(isQuestionAnswered(q, {}, {})).toBe(false);
  });
});

describe("questionTabLabel", () => {
  it("优先 header；无 header 截断问题；空问题回退序号", () => {
    expect(questionTabLabel({ question: "长问题超出八个字需要截断显示", options: [] }, 0)).toBe(
      "长问题超出八个字…",
    );
    expect(questionTabLabel({ header: "traceId", question: "有没有？", options: [] }, 1)).toBe(
      "traceId",
    );
    expect(questionTabLabel({ question: "  ", options: [] }, 2)).toBe("问题 3");
  });
});
