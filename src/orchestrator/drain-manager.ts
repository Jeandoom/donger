/**
 * 排水管理器（热发布优雅停机，spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md M1）
 *
 * SIGTERM 后先排水：停新作业受理、向 SSE 广播发布中、等在途轮自然完成（上限
 * DONGER_DRAIN_TIMEOUT_MS，默认 10 分钟）；超时仍未完成的轮交给 markInterrupted 标记
 * （M2 接入，新实例启动后自动续跑），然后才允许进程退出。发布真空窗只剩新实例启动的几秒。
 *
 * hooks 由 index.ts 在全部常驻组件装配完成后 setHooks 注入（晚绑定）；本类自身无 IO。
 */

export interface DrainStatus {
  draining: boolean;
  activeTurns: number;
  queuedMessages: number;
  deadline?: number;
  reason?: string;
}

/** 新作业拒入闸（orchestrator.handleMessage / web 发送路由共用判定） */
export interface DrainGate {
  shouldRejectNewTurn(): boolean;
}

export interface DrainHooks {
  /** 排水起点：停后台常驻（scheduler / 事件泵 / worktree GC / 记忆整理） */
  stopBackgroundJobs(): void;
  /** 向全部活跃 SSE 广播排水提示 */
  broadcastDraining(status: DrainStatus): void;
  /** 在途轮计数（orchestrator 活跃任务扁平化，含钉钉等其他渠道实例） */
  activeTurnCount(): number;
  /** busy 会话排队中的消息计数（排水等待须连同队列一起清零） */
  queuedMessageCount(): number;
  /** 退回全部排队消息（入提示，不静默丢） */
  flushQueues(reason: string): Promise<void>;
  /** 排水超时兜底：标记仍未完成的轮为 interrupted（M2 接入；缺省不标记） */
  markInterrupted?(): Promise<number>;
}

const POLL_INTERVAL_MS = 500;

export class DrainManager implements DrainGate {
  private state: "normal" | "draining" = "normal";
  private deadline?: number;
  private reason?: string;
  private drainingPromise?: Promise<void>;
  private hooks?: DrainHooks;

  setHooks(hooks: DrainHooks): void {
    this.hooks = hooks;
  }

  shouldRejectNewTurn(): boolean {
    return this.state === "draining";
  }

  status(): DrainStatus {
    return {
      draining: this.state === "draining",
      activeTurns: this.hooks?.activeTurnCount() ?? 0,
      queuedMessages: this.hooks?.queuedMessageCount() ?? 0,
      ...(this.deadline !== undefined ? { deadline: this.deadline } : {}),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    };
  }

  /** 幂等：重复信号（SIGTERM+SIGINT 连发）复用同一次排水 */
  beginDrain(opts: { timeoutMs: number; reason: string }): Promise<void> {
    if (this.drainingPromise) return this.drainingPromise;
    this.state = "draining";
    this.reason = opts.reason;
    this.deadline = Date.now() + opts.timeoutMs;
    this.drainingPromise = this.run(opts.timeoutMs);
    return this.drainingPromise;
  }

  /** 复位到常态：生产进程排水后随即退出不会用到；供发布中止/测试恢复受理 */
  reset(): void {
    this.state = "normal";
    this.deadline = undefined;
    this.reason = undefined;
    this.drainingPromise = undefined;
  }

  private async run(timeoutMs: number): Promise<void> {
    const hooks = this.hooks;
    console.log(
      `[drain] 排水开始 reason=${this.reason} timeoutMs=${timeoutMs}` +
        ` activeTurns=${hooks?.activeTurnCount() ?? 0} queued=${hooks?.queuedMessageCount() ?? 0}`,
    );
    hooks?.stopBackgroundJobs();
    hooks?.broadcastDraining(this.status());
    await hooks
      ?.flushQueues("服务正在更新发布")
      .catch((e) => console.error("[drain] 排队消息退回失败", e));

    const deadline = this.deadline ?? Date.now() + timeoutMs;
    for (;;) {
      const turns = hooks?.activeTurnCount() ?? 0;
      const queued = hooks?.queuedMessageCount() ?? 0;
      if (turns === 0 && queued === 0) {
        console.log("[drain] 在途轮与队列已清空，允许退出");
        return;
      }
      if (Date.now() >= deadline) {
        console.log(`[drain] 排水超时：剩余在途轮 ${turns} 条，标记后退出`);
        try {
          const marked = (await hooks?.markInterrupted?.()) ?? 0;
          if (marked > 0) console.log(`[drain] 已标记 ${marked} 个中断轮（重启后自动续跑）`);
        } catch (e) {
          console.error("[drain] 中断标记失败（不影响退出）", e);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}
