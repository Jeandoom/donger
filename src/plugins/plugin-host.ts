import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  disableBlockers,
  isPluginEnabled,
  type PluginManifest,
  PluginManifestSchema,
  type PluginRecord,
  type PluginSnapshot,
  type PluginSource,
  type PluginView,
  unmetRequires,
} from "../domain/plugin.js";
import type { PluginStore } from "../ports/plugin-store.js";
import type { Logger } from "../util/logger.js";

export interface PluginHostDeps {
  /** 内置插件 manifest 目录（<repo>/plugins/builtin） */
  builtinDir: string;
  store: PluginStore;
  log: Logger;
}

export interface ManifestScan {
  manifests: Map<string, PluginManifest>;
  /** 解析失败的目录（fail-soft：坏 manifest 不炸启动，error 上报日志） */
  errors: Array<{ dir: string; reason: string }>;
}

/** 扫描 builtin 目录的 plugin.json（幂等纯读；单文件坏不影响其余） */
export function scanBuiltinManifests(builtinDir: string, log: Logger): ManifestScan {
  const manifests = new Map<string, PluginManifest>();
  const errors: ManifestScan["errors"] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(builtinDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    log.warn({ err, builtinDir }, "内置插件目录不可读（首次部署未随版携带？）");
    return { manifests, errors };
  }
  for (const dir of entries) {
    const file = join(builtinDir, dir, "plugin.json");
    try {
      const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        errors.push({ dir, reason: parsed.error.issues.map((i) => i.message).join("; ") });
        continue;
      }
      if (parsed.data.id !== dir) {
        errors.push({ dir, reason: `manifest id=${parsed.data.id} 与目录名不一致` });
        continue;
      }
      manifests.set(parsed.data.id, parsed.data);
    } catch (err) {
      errors.push({ dir, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { manifests, errors };
}

function manifestSource(kind: PluginManifest["kind"]): PluginSource {
  return kind === "engine" ? "bundled" : "builtin";
}

/**
 * 插件装载器（specs/2026-10-11-plugin-system-design.md §1.3）：
 * 启动时扫描 builtin manifest ↔ plugins 表对账（新增补登记/消失标 missing/
 * core+stoppable 等以 manifest 为准保护性纠偏），产出进程内快照供各装配点过滤。
 * enabled 是 admin 决策：对账永不改写（store.upsert 的 DO UPDATE 不含该列）。
 */
export class PluginHost {
  private cached?: PluginSnapshot;

  constructor(private readonly deps: PluginHostDeps) {}

  /** 启动装配阶段调用；返回有效插件集 */
  async init(): Promise<PluginSnapshot> {
    const { manifests, errors } = scanBuiltinManifests(this.deps.builtinDir, this.deps.log);
    for (const e of errors) {
      this.deps.log.warn({ dir: e.dir, reason: e.reason }, "内置插件 manifest 解析失败（跳过）");
    }
    await this.reconcile(manifests);
    this.cached = await this.buildSnapshot();
    this.deps.log.info(
      {
        total: this.cached.plugins.length,
        enabled: this.cached.plugins.filter((p) => p.enabled).length,
        manifestErrors: errors.length,
      },
      "插件注册表对账完成",
    );
    return this.cached;
  }

  /** 进程内快照（init 后可用；未 init 返回 undefined 语义由 isPluginEnabled fail-open 兜底） */
  snapshot(): PluginSnapshot | undefined {
    return this.cached;
  }

  async list(): Promise<PluginView[]> {
    return (await this.buildSnapshot()).plugins;
  }

  /** 启停（M1 引擎/M2 能力共用入口）：前置校验不过返回 blockers，不落库 */
  async setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; blockers: string[] }> {
    const views = (await this.buildSnapshot()).plugins;
    if (!enabled) {
      const blockers = disableBlockers(views, id);
      if (blockers.length > 0) return { ok: false, blockers };
    } else {
      const missing = unmetRequires(views, id);
      if (missing.length > 0)
        return { ok: false, blockers: missing.map((t) => `依赖「${t}」未启用，须先启用依赖`) };
    }
    await this.deps.store.setEnabled(id, enabled);
    // 缓存快照整体重建（snapshot()/各装配点 gate 的唯一读取面；e2e 实锤：只改临时
    // 副本不刷缓存会让停用在底账与执行面之间漂移到重启才生效）
    this.cached = await this.buildSnapshot();
    return { ok: true, blockers: [] };
  }

  private async reconcile(manifests: Map<string, PluginManifest>): Promise<void> {
    const rows = new Map((await this.deps.store.list()).map((r) => [r.id, r]));
    const now = new Date().toISOString();
    for (const [id, m] of manifests) {
      const existing = rows.get(id);
      const record: PluginRecord = {
        id,
        kind: m.kind,
        ...(m.version !== undefined ? { version: m.version } : {}),
        core: m.core,
        stoppable: m.stoppable,
        ...(m.scope !== undefined ? { scope: m.scope } : {}),
        source: manifestSource(m.kind),
        enabled: existing?.enabled ?? true,
        // 存量行状态保留（M1 引擎安装器/安装器会显式改）；新行 ready
        status: existing?.status ?? "ready",
        ...(existing?.error !== undefined ? { error: existing.error } : {}),
        requires: m.requires,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
      const drifted =
        !existing ||
        existing.kind !== record.kind ||
        existing.core !== record.core ||
        existing.stoppable !== record.stoppable ||
        existing.scope !== record.scope ||
        existing.source !== record.source ||
        existing.version !== record.version ||
        JSON.stringify(existing.requires) !== JSON.stringify(record.requires);
      if (drifted) await this.deps.store.upsert(record);
    }
    // 有行无 manifest：pack 生命周期归安装器不动；其余（防御）标 missing
    for (const [id, row] of rows) {
      if (!manifests.has(id) && row.kind !== "pack" && row.status !== "missing") {
        await this.deps.store.setStatus(id, "missing", "manifest 不存在（内置清单已移除？）");
      }
    }
  }

  private async buildSnapshot(): Promise<PluginSnapshot> {
    const { manifests } = scanBuiltinManifests(this.deps.builtinDir, this.deps.log);
    const rows = await this.deps.store.list();
    const plugins: PluginView[] = rows.map((row) => {
      const m = manifests.get(row.id);
      return {
        ...row,
        title: m?.title ?? row.id,
        ...(m?.description !== undefined ? { description: m.description } : {}),
        ...(m?.contributes !== undefined ? { contributes: m.contributes } : {}),
      };
    });
    return { plugins, generatedAt: new Date().toISOString() };
  }
}

export { isPluginEnabled };
