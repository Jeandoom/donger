// 插件系统（specs/2026-10-11-plugin-system-design.md）数据获取。
// 管理面 admin-only；snapshot 登录即可读（导航/编辑器过滤数据源）。
import { apiFetch } from "./auth";

export type PluginKind = "capability" | "engine" | "pack";
export type PluginStatus = "ready" | "missing" | "error";

export interface PluginContributes {
  agentConfigFields?: string[];
  navEntries?: string[];
}

export interface PluginView {
  id: string;
  kind: PluginKind;
  version?: string;
  core: boolean;
  stoppable: boolean;
  scope?: "agent" | "platform";
  source: string;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  requires: string[];
  title: string;
  description?: string;
  contributes?: PluginContributes;
  installedAt: string;
  updatedAt: string;
}

export interface PluginSnapshotDTO {
  plugins: PluginView[];
  generatedAt: string;
}

export async function fetchAdminPlugins(): Promise<PluginView[]> {
  const r = await apiFetch("/api/admin/plugins");
  if (!r.ok) throw new Error(`加载插件清单失败：HTTP ${r.status}`);
  const data = (await r.json()) as { plugins: PluginView[] };
  return data.plugins;
}

export async function fetchPluginSnapshot(): Promise<PluginSnapshotDTO> {
  const r = await apiFetch("/api/plugins/snapshot");
  if (!r.ok) throw new Error(`加载插件快照失败：HTTP ${r.status}`);
  return (await r.json()) as PluginSnapshotDTO;
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; blockers: string[] }> {
  const r = await apiFetch(`/api/admin/plugins/${encodeURIComponent(id)}/enabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    blockers?: string[];
    error?: string;
  };
  if (!r.ok) throw new Error(data.error ?? `操作失败（HTTP ${r.status}）`);
  return { ok: data.ok === true, blockers: data.blockers ?? [] };
}

// ===== 引擎运行时（工件安装/冒烟/解析链；specs §9.5）=====

export interface EngineRuntimeDTO {
  sdkType: string;
  sourceKind: "bundled" | "discover" | "remote" | "local";
  sourceRef?: string;
  pinnedVersion?: string;
  installedPath?: string;
  sha256?: string;
  managed: boolean;
  status: "missing" | "installing" | "ready" | "error" | "drifted" | "disabled";
  lastError?: string;
  lastSmokeAt?: string;
}

export interface EngineRuntimeStatus {
  runtimes: EngineRuntimeDTO[];
  resolution: Record<string, { path: string; pinned: boolean; source: string }>;
}

export async function fetchEngineRuntimes(): Promise<EngineRuntimeStatus> {
  const r = await apiFetch("/api/admin/engine-runtimes");
  if (!r.ok) throw new Error(`加载引擎运行时状态失败：HTTP ${r.status}`);
  return (await r.json()) as EngineRuntimeStatus;
}

export interface EngineInstallInput {
  sourceKind: "discover" | "remote" | "local";
  sourceRef?: string;
  sha256?: string;
}

export async function installEngineRuntime(
  sdkType: string,
  input: EngineInstallInput,
): Promise<EngineRuntimeDTO> {
  const r = await apiFetch(
    `/api/admin/engine-runtimes/${encodeURIComponent(sdkType)}/install`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const data = (await r.json().catch(() => ({}))) as {
    runtime?: EngineRuntimeDTO;
    error?: string;
  };
  if (!r.ok) throw new Error(data.error ?? `安装失败（HTTP ${r.status}）`);
  return data.runtime!;
}

export async function smokeEngineRuntime(sdkType: string): Promise<string | undefined> {
  const r = await apiFetch(`/api/admin/engine-runtimes/${encodeURIComponent(sdkType)}/smoke`, {
    method: "POST",
  });
  const data = (await r.json().catch(() => ({}))) as { version?: string; error?: string };
  if (!r.ok) throw new Error(data.error ?? `冒烟失败（HTTP ${r.status}）`);
  return data.version;
}

/** 停用的导航路径集（snapshot 里 enabled=false 插件的 navEntries 并集；空=不过滤） */
export function disabledNavEntries(snapshot: PluginSnapshotDTO | undefined): Set<string> {
  const out = new Set<string>();
  for (const p of snapshot?.plugins ?? []) {
    if (p.enabled) continue;
    for (const nav of p.contributes?.navEntries ?? []) out.add(nav);
  }
  return out;
}
