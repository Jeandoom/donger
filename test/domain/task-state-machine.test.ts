import { describe, expect, it } from "vitest";
import { canTransition, nextStatus, type TaskEvent } from "../../src/domain/task-state-machine.js";

describe("TaskStateMachine", () => {
  it("合法主链：created→planning→running→awaiting_approval→running→done", () => {
    let s = nextStatus("created", "plan");
    expect(s).toBe("planning");
    s = nextStatus(s, "start");
    expect(s).toBe("running");
    s = nextStatus(s, "request_approval");
    expect(s).toBe("awaiting_approval");
    s = nextStatus(s, "resume");
    expect(s).toBe("running");
    s = nextStatus(s, "finish");
    expect(s).toBe("done");
  });

  it("running→failed / running→canceled", () => {
    expect(nextStatus("running", "fail")).toBe("failed");
    expect(nextStatus("running", "cancel")).toBe("canceled");
  });

  it("created→canceled / planning→canceled", () => {
    expect(nextStatus("created", "cancel")).toBe("canceled");
    expect(nextStatus("planning", "cancel")).toBe("canceled");
  });

  it("awaiting_approval→failed", () => {
    expect(nextStatus("awaiting_approval", "fail")).toBe("failed");
  });

  it("终态无出边：done/failed/canceled 对任意事件非法", () => {
    const events: TaskEvent[] = [
      "plan",
      "start",
      "request_approval",
      "resume",
      "finish",
      "fail",
      "cancel",
    ];
    for (const terminal of ["done", "failed", "canceled"] as const) {
      for (const ev of events) {
        expect(canTransition(terminal, ev)).toBe(false);
      }
    }
  });

  it("非法转换抛错", () => {
    expect(() => nextStatus("done", "start")).toThrow();
    expect(() => nextStatus("created", "start")).toThrow();
  });

  it("canTransition 返回值正确", () => {
    expect(canTransition("created", "plan")).toBe(true);
    expect(canTransition("created", "start")).toBe(false);
    expect(canTransition("running", "finish")).toBe(true);
  });
});
