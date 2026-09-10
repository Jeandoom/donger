import type { RunnerEvent } from "../domain/types.js";

/** 由 SDK 事件流推导的实时执行状态（观测态，不落库；任务治理态仍由 TaskStatus 承载） */
export interface ActivitySnapshot {
  state: "thinking" | "text" | "tool";
  /** state=tool 时的工具名与调用 id */
  toolName?: string;
  toolUseId?: string;
  /** 当前状态开始的时刻（ISO） */
  startedAt: string;
  /** 最近一次事件的时刻（ISO，供前端判观测新鲜度） */
  lastEventAt: string;
}

/**
 * 会话级活动追踪器（进程内存态）：消费 runTurn 的事件流，维护「正在想/正在输出/正在跑什么工具」。
 * key = conversationId（同会话经 orchestrator busy 锁串行，无并发写）。
 * result 事件或 end() 清除条目；进程重启自然清零（遗留 running 任务由启动清扫标记失败）。
 */
export class ActivityTracker {
  private readonly activities = new Map<string, ActivitySnapshot>();

  /** 消费一个 runner 事件并推进状态；幂等，未知事件类型忽略 */
  observe(conversationId: string, event: RunnerEvent): void {
    const now = new Date().toISOString();
    switch (event.type) {
      case "thinking_delta":
        this.set(conversationId, { state: "thinking", startedAt: now, lastEventAt: now });
        break;
      case "text_delta":
        this.set(conversationId, { state: "text", startedAt: now, lastEventAt: now });
        break;
      case "tool_use":
        this.set(conversationId, {
          state: "tool",
          toolName: event.tool,
          toolUseId: event.toolUseId,
          startedAt: now,
          lastEventAt: now,
        });
        break;
      case "tool_result":
        // 工具结束、模型处理结果中：回 thinking（下一事件会继续推进）
        this.set(conversationId, { state: "thinking", startedAt: now, lastEventAt: now });
        break;
      case "result":
        this.end(conversationId);
        break;
      default:
        break;
    }
  }

  /** 回合结束清除（含 abort/异常路径；无条目时幂等） */
  end(conversationId: string): void {
    this.activities.delete(conversationId);
  }

  get(conversationId: string): ActivitySnapshot | undefined {
    return this.activities.get(conversationId);
  }

  private set(conversationId: string, snapshot: ActivitySnapshot): void {
    this.activities.set(conversationId, snapshot);
  }
}
