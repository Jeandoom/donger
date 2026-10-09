import type { EventFiring } from "../domain/event-firing.js";

/** 触发记录存储（永久保留，D5） */
export interface EventFiringStore {
  migrate(): void;
  insert(firing: EventFiring): Promise<EventFiring>;
  get(id: string): Promise<EventFiring | undefined>;
  listByEvent(eventId: string, opts?: { limit?: number; before?: string }): Promise<EventFiring[]>;
  /** admin 巡检预留：按属主列出（当前 UI 不用） */
  listByOwner(ownerId: string, opts?: { limit?: number; before?: string }): Promise<EventFiring[]>;
}
