import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/util/logger.js";

interface PinoEntry {
  level: number;
  msg?: string;
  scope?: string;
  [k: string]: unknown;
}

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const lines = (): PinoEntry[] =>
    chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PinoEntry);
  return { stream, lines };
}

describe("createLogger (pino)", () => {
  it("按级别过滤：warn 级别只输出 warn(40)/error(50)", () => {
    const { stream, lines } = capture();
    const log = createLogger("warn", "app", stream);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(
      lines()
        .map((e) => e.level)
        .sort((a, b) => a - b),
    ).toEqual([40, 50]);
  });

  it("scope 注入到每条日志", () => {
    const { stream, lines } = capture();
    const log = createLogger("info", "orch", stream);
    log.info("hi");
    const e = lines()[0];
    expect(e?.scope).toBe("orch");
    expect(e?.msg).toBe("hi");
  });

  it("child 继承作用域与级别，可叠加 binding", () => {
    const { stream, lines } = capture();
    const log = createLogger("debug", "app", stream).child({ component: "store" });
    log.debug("d");
    const e = lines()[0];
    expect(e?.component).toBe("store");
    expect(e?.scope).toBe("app");
    expect(e?.level).toBe(20);
  });
});
