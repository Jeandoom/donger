import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  ChannelError,
  ConfigError,
  describeZodError,
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

describe("describeZodError", () => {
  it("refine（custom）issue 保留中文原文，带字段路径前缀", () => {
    const r = z
      .object({ cron: z.string().refine(() => false, "cron 表达式非法：需 5 段") })
      .safeParse({ cron: "bad" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(describeZodError(r.error)).toBe("参数校验未通过：cron cron 表达式非法：需 5 段");
    }
  });

  it("invalid_type 映射中文；多 issue 取前三并带总数", () => {
    const schema = z.object({ a: z.string(), b: z.number(), c: z.boolean(), d: z.string() });
    const r = schema.safeParse({ a: 1, b: "x", c: "y", d: 5 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = describeZodError(r.error);
      expect(msg).toContain("等 4 处");
      expect(msg).toContain("类型不正确");
      expect(msg.split("；").length).toBe(3);
    }
  });
});
