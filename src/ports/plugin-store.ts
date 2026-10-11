import type { PluginRecord } from "../domain/plugin.js";

/** 插件治理状态存储（specs/2026-10-11-plugin-system-design.md §1.2；manifest 内容不进库） */
export interface PluginStore {
  list(): Promise<PluginRecord[]>;
  get(id: string): Promise<PluginRecord | undefined>;
  upsert(record: PluginRecord): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setStatus(id: string, status: PluginRecord["status"], error?: string): Promise<void>;
}
