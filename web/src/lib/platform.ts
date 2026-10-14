import { apiFetch } from "./auth";

/**
 * 平台环境约束（知识体系轮 P1）：admin 编辑的 markdown 文本，orchestrator
 * 组装默认提示词时注入「## 平台环境约束」节，改即生效（每轮现取）。
 */
export async function fetchPlatformNotes(): Promise<string> {
  const r = await apiFetch("/api/admin/platform-notes");
  if (!r.ok) throw new Error(`platform-notes ${r.status}`);
  const body = (await r.json()) as { notes: string };
  return body.notes;
}

export async function savePlatformNotes(notes: string): Promise<void> {
  const r = await apiFetch("/api/admin/platform-notes", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(text || `platform-notes ${r.status}`);
  }
}

// ---- 记忆通道（知识体系轮 P2）----

export type MemoryChannelMode = "curated" | "legacy" | "off";

export interface KbMemoryDTO {
  mode: MemoryChannelMode;
  curated: Array<{ filename: string; summary: string }>;
  indexLines: number;
  indexTruncated: boolean;
  legacyCount: number;
}

export async function fetchKbMemory(kbId: string): Promise<KbMemoryDTO> {
  const r = await apiFetch(`/api/kb/${kbId}/memory`);
  if (!r.ok) throw new Error(`kb-memory ${r.status}`);
  return (await r.json()) as KbMemoryDTO;
}

/** 一次性迁移：memory/ 顶层旧条目 → archive/ */
export async function migrateKbLegacyMemory(kbId: string): Promise<number> {
  const r = await apiFetch(`/api/kb/${kbId}/memory/migrate-legacy`, { method: "POST" });
  if (!r.ok) throw new Error(`kb-memory-migrate ${r.status}`);
  const body = (await r.json()) as { moved: number };
  return body.moved;
}

export async function fetchMemoryChannel(): Promise<MemoryChannelMode> {
  const r = await apiFetch("/api/admin/memory-channel");
  if (!r.ok) throw new Error(`memory-channel ${r.status}`);
  const body = (await r.json()) as { mode: MemoryChannelMode };
  return body.mode;
}

export async function saveMemoryChannel(mode: MemoryChannelMode): Promise<void> {
  const r = await apiFetch("/api/admin/memory-channel", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!r.ok) throw new Error(`memory-channel ${r.status}`);
}
