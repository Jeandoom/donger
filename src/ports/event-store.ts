import type { Event, EventInput } from "../domain/event.js";

export interface EventStore {
  migrate(): void;
  create(input: EventInput & { ownerId: string }): Promise<Event>;
  get(id: string): Promise<Event | undefined>;
  listByOwner(ownerId: string): Promise<Event[]>;
  /** 全量（系统事件分发等跨 owner 查找用） */
  listAll(): Promise<Event[]>;
  update(id: string, patch: EventInput): Promise<Event>;
  delete(id: string): Promise<void>;
  /** 调用事件入口按路径查找（/hooks/<random>） */
  findByCallPath(path: string): Promise<Event | undefined>;
  /** 运行态回写（lastFiredAt/nextRunAt 展示用） */
  updateRuntimeState(
    id: string,
    patch: Partial<Pick<Event, "lastFiredAt" | "nextRunAt">>,
  ): Promise<void>;
}
