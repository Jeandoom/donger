import { describe, expect, it } from "vitest";
import {
  AppError,
  ChannelError,
  ConfigError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
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

  it("ForbiddenError/NotFoundError/PayloadTooLargeError 走 instanceof 链", () => {
    const f = new ForbiddenError("FORBIDDEN", "越界");
    expect(f.code).toBe("FORBIDDEN");
    expect(f.name).toBe("ForbiddenError");
    expect(f).toBeInstanceOf(AppError);

    const n = new NotFoundError("NOT_FOUND", "文件不存在");
    expect(n.code).toBe("NOT_FOUND");
    expect(n.name).toBe("NotFoundError");

    const p = new PayloadTooLargeError("TOO_LARGE", "超 5MB");
    expect(p.code).toBe("TOO_LARGE");
    expect(p.name).toBe("PayloadTooLargeError");
  });
});
