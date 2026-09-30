import { apiFetch } from "./auth";

/**
 * 系统密钥管理 API（授权页·密钥管理；admin 专属，接口侧守卫 fail-closed）：
 * 状态/轮换/导入历史密钥/深度修复。密钥明文永不回显，只回指纹。
 */

export type SystemKeySource = "generated" | "env_imported" | "rotated" | "imported" | "upgraded";

export const SYSTEM_KEY_SOURCE_LABEL: Record<SystemKeySource, string> = {
  generated: "自动生成",
  env_imported: "环境变量导入",
  rotated: "轮换",
  imported: "手动导入",
  upgraded: "升级补录",
};

export interface SystemKeyHistoryEntry {
  fingerprint: string;
  source: SystemKeySource;
  note?: string;
  createdAt: string;
  /** null = 当前生效密钥（head） */
  retiredAt: string | null;
}

export interface SystemKeyStatus {
  fingerprint: string;
  source: SystemKeySource;
  createdAt: string;
  history: SystemKeyHistoryEntry[];
  /** 启动时仍检测到 SECRET_KEY/JWT_SECRET env（DB 优先语义下仅提示，不生效） */
  envKeyPresent: boolean;
  envKeyMatches: boolean;
}

export interface ReEncryptFailure {
  kind: string;
  name: string;
  field: string;
}

export interface ReEncryptReport {
  scanned: number;
  healthy: number;
  healed: number;
  sourceSeeds: number;
  failed: ReEncryptFailure[];
}

export interface RotateResult {
  report: ReEncryptReport;
  /** 轮换提交后复扫：捕获轮换窗口内在途写入的旧钥残留 */
  leftover: ReEncryptReport;
  fingerprint: string;
}

async function readError(r: Response, fallback: string): Promise<never> {
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? `${fallback}（HTTP ${r.status}）`);
}

export async function fetchSystemKeyStatus(): Promise<SystemKeyStatus> {
  const r = await apiFetch("/api/admin/secret-key");
  if (!r.ok) await readError(r, "加载密钥状态失败");
  return (await r.json()) as SystemKeyStatus;
}

/** 轮换系统密钥：generate=true 一键随机；否则用 newValue；数据自动重加密 */
export async function rotateSystemKey(
  input: { generate?: boolean; newValue?: string; note?: string } = { generate: true },
): Promise<RotateResult> {
  const r = await apiFetch("/api/admin/secret-key/rotate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) await readError(r, "轮换失败");
  return (await r.json()) as RotateResult;
}

/** 导入历史密钥（外部漂移数据的恢复通道），入库后立即以它为来源修复 */
export async function importSystemKeyHistory(input: {
  seed: string;
  note?: string;
}): Promise<ReEncryptReport> {
  const r = await apiFetch("/api/admin/secret-key/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) await readError(r, "导入失败");
  return ((await r.json()) as { report: ReEncryptReport }).report;
}

/** 深度修复：以全部历史密钥为来源，把仍解不开的密文收编到当前密钥（幂等） */
export async function repairSystemKeys(): Promise<ReEncryptReport> {
  const r = await apiFetch("/api/admin/secret-key/repair", { method: "POST" });
  if (!r.ok) await readError(r, "深度修复失败");
  return ((await r.json()) as { report: ReEncryptReport }).report;
}
