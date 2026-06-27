import { describe, expect, it } from "vitest";
import {
  AppError,
  ChannelError,
  ConfigError,
  RunnerError,
  TaskError,
  ValidationError,
} from "../../src/util/errors.js";

describe("AppError", () => {
  it("携带 code/message，name 取子类名", () => {
    const e = new ConfigError("CONFIG_INVALID", "缺 token");
    expect(e.code).toBe("CONFIG_INVALID");
    expect(e.message).toBe("缺 token");
    expect(e.name).toBe("ConfigError");
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
  });

  it("cause 通过 ES2022 Error cause 传播", () => {
    const root = new Error("boom");
    const e = new TaskError("TASK_FAIL", "失败", root);
    expect(e.cause).toBe(root);
  });

  it("各子类 instanceof 链", () => {
    expect(new ChannelError("CH_BAD", "x")).toBeInstanceOf(AppError);
    expect(new RunnerError("RUNNER_FAIL", "x")).toBeInstanceOf(AppError);
    expect(new ValidationError("VALIDATION_BAD", "x")).toBeInstanceOf(AppError);
  });
});
