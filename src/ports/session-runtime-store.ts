// 会话 dev server 运行态登记（2026-11-04 网站游戏开发闭环 spec §3.3）。
// 一个会话至多一个存活 dev server；端口 127.0.0.1 随机分配，由 /preview/:convId/* 反代消费。
// 进程不跨重启恢复：平台启动时全量 running→stopped（对账）。

export type SessionRuntimeStatus = "running" | "stopped";

export interface SessionRuntimeEntry {
  conversationId: string;
  ownerId: string;
  agentId: string | null;
  port: number;
  /** 启动命令（{port} 占位已替换为实际端口） */
  cmd: string;
  pid: number | null;
  status: SessionRuntimeStatus;
  startedAt: string;
  lastAccessAt: string;
}

export interface SessionRuntimeStore {
  /**
   * 登记启动。同会话已有 running 行时幂等返回既有行（不覆盖、不重复起进程）；
   * 仅有 stopped 行时覆盖重记。
   */
  register(
    entry: Omit<SessionRuntimeEntry, "status" | "startedAt" | "lastAccessAt"> & {
      status?: SessionRuntimeStatus;
      startedAt?: string;
      lastAccessAt?: string;
    },
  ): Promise<SessionRuntimeEntry>;
  get(conversationId: string): Promise<SessionRuntimeEntry | undefined>;
  /** 标记停止（status=stopped、pid 置空） */
  markStopped(conversationId: string): Promise<boolean>;
  /** 续期（反代每次访问刷新，闲置回收依据） */
  touch(conversationId: string, at?: string): Promise<void>;
  /** 全部 running 行（并发限额与闲置清扫用） */
  listRunning(): Promise<SessionRuntimeEntry[]>;
  /** 删除行 */
  remove(conversationId: string): Promise<boolean>;
  /** 启动对账：全部 running→stopped，返回改写行数 */
  markAllStopped(): Promise<number>;
}
