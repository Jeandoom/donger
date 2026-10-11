import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isPrivateNetHost } from "../domain/net-target.js";
import type {
  EngineRuntimeRecord,
  EngineRuntimeStore,
} from "../ports/engine-runtime-store.js";
import type { SystemEventStore } from "../ports/system-event-store.js";
import type { Logger } from "../util/logger.js";
import {
  probeZcodeCliFallback,
  resolveBuiltinProviderConfig,
} from "./zcode-agent-runner.js";

export interface EngineRuntimeServiceDeps {
  store: EngineRuntimeStore;
  systemEvents: SystemEventStore;
  /** 受管安装根（<data>/engines；随库备份体系走） */
  enginesDir: string;
  log: Logger;
  /** 测试注入 env（缺省 process.env） */
  env?: Record<string, string | undefined>;
}

export interface InstallInput {
  sourceKind: "discover" | "remote" | "local";
  /** remote=文件 URL；local=CLI 入口路径（discover 忽略） */
  sourceRef?: string;
  /** remote 期望 sha256（留空=下载后计算，安装结果回显由 admin 复核——首装信任链以冒烟为准） */
  sha256?: string;
}

export interface ResolutionInfo {
  path: string;
  /** true=env 显式配置或注册表钉版；false=桌面候选降级（随第三方更新漂移） */
  pinned: boolean;
  source: "env" | "registry" | "fallback";
}

export interface EngineStatus {
  runtimes: EngineRuntimeRecord[];
  /** 当前解析链现状（每 sdkType；bundled 引擎无外部工件不参与） */
  resolution: Record<string, ResolutionInfo>;
}

const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SMOKE_TIMEOUT_MS = 15_000;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** CLI 入口形态：.cjs/.mjs/.js 用 node 执行（与 zcode-protocol-client 同一判定） */
function isScriptEntry(path: string): boolean {
  return /\.(cjs|mjs|js)$/i.test(path);
}

async function runSmoke(cliPath: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  const args = isScriptEntry(cliPath) ? [cliPath, "--version"] : ["--version"];
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (r: { ok: boolean; version?: string; error?: string }) => {
      if (!settled) {
        settled = true;
        resolvePromise(r);
      }
    };
    try {
      const child = spawn(isScriptEntry(cliPath) ? process.execPath : cliPath, args, {
        timeout: SMOKE_TIMEOUT_MS,
        windowsHide: true,
      });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("error", (err) => done({ ok: false, error: `冒烟进程启动失败：${err.message}` }));
      child.on("close", (code) => {
        const version = out.match(/(\d+\.\d+\.\d+[^\s]*)/)?.[1];
        if (code === 0 && version) done({ ok: true, version });
        else
          done({
            ok: false,
            error: `冒烟失败（exit=${code}）：${out.slice(0, 300).trim() || "无输出"}`,
          });
      });
    } catch (err) {
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * 引擎运行时服务（specs/2026-10-11-plugin-system-design.md §1.3/§9.5）：
 * 安装三来源（本机发现复制/远程单文件/本地直引）+ 冒烟激活 + 解析链（env →
 * 注册表 ready → 桌面候选降级显性）+ 漂移检测（启动+24h，只报警不自动更换）。
 * fail-closed：只有 status=ready 且 managed=1 的行被解析链消费；任何失败不触碰现行解析。
 */
export class EngineRuntimeService {
  private driftTimer?: NodeJS.Timeout;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly deps: EngineRuntimeServiceDeps) {
    this.env = deps.env ?? process.env;
  }

  /** 启动装配：热行缓存（解析链同步读取）→ 清理中断安装 → 漂移检测首跑 + 24h 定时 */
  async start(): Promise<void> {
    await this.refreshCache();
    await this.sweepStaleInstalling();
    void this.checkDrift();
    this.driftTimer = setInterval(() => void this.checkDrift(), DRIFT_CHECK_INTERVAL_MS);
    this.driftTimer.unref?.();
  }

  stop(): void {
    if (this.driftTimer) clearInterval(this.driftTimer);
  }

  async status(): Promise<EngineStatus> {
    const runtimes = await this.deps.store.list();
    const resolution: Record<string, ResolutionInfo> = {};
    const zcode = this.resolveCliPathInfo();
    if (zcode) resolution.zcode = zcode;
    return { runtimes, resolution };
  }

  /** 解析链：env 逃生门 → 注册表钉版 → 桌面候选降级（降级命中打 info 留痕） */
  resolveCliPathInfo(sdkType = "zcode"): ResolutionInfo | undefined {
    if (sdkType !== "zcode") return undefined;
    const configured = this.env.DONGER_ZCODE_CLI_PATH?.trim();
    if (configured && existsSync(configured)) {
      return { path: configured, pinned: true, source: "env" };
    }
    const row = this.cachedRows?.get(sdkType);
    if (
      row &&
      row.status === "ready" &&
      row.managed &&
      row.installedPath &&
      existsSync(row.installedPath)
    ) {
      return { path: row.installedPath, pinned: true, source: "registry" };
    }
    const fallback = probeZcodeCliFallback();
    if (fallback) {
      this.deps.log.info(
        { path: fallback, registryStatus: row?.status ?? "missing" },
        "ZCode CLI 解析链落桌面候选降级态（未钉版，随第三方更新漂移）",
      );
      return { path: fallback, pinned: false, source: "fallback" };
    }
    return undefined;
  }

  private cachedRows?: Map<string, EngineRuntimeRecord>;

  /** 供解析链读取的最新行缓存（install/smoke/drift 后刷新） */
  private async refreshCache(): Promise<void> {
    this.cachedRows = new Map((await this.deps.store.list()).map((r) => [r.sdkType, r]));
  }

  /** 手动重跑冒烟：ready 行校验工件仍可用；missing/error 行按 installedPath 尝试复活 */
  async smoke(sdkType: string): Promise<{ ok: boolean; version?: string; error?: string }> {
    const row = await this.deps.store.get(sdkType);
    if (!row) return { ok: false, error: `引擎未登记：${sdkType}` };
    if (row.sourceKind === "bundled") {
      return { ok: false, error: "内置引擎随平台发版，无需冒烟" };
    }
    const target = row.installedPath;
    if (!target || !existsSync(target)) {
      await this.markError(sdkType, row, "工件不存在（可能已被删除）");
      return { ok: false, error: "工件不存在（可能已被删除）" };
    }
    const result = await runSmoke(target);
    const now = new Date().toISOString();
    if (result.ok) {
      await this.deps.store.upsert({
        ...row,
        pinnedVersion: result.version ?? row.pinnedVersion,
        sha256: row.managed ? sha256File(target) : row.sha256,
        status: "ready",
        lastError: undefined,
        lastSmokeAt: now,
        updatedAt: now,
      });
      await this.recordEvent(`engine_smoke_ok`, `${sdkType} 冒烟通过（v${result.version ?? "?"}）`);
    } else {
      await this.markError(sdkType, row, result.error ?? "冒烟失败");
    }
    await this.refreshCache();
    return result;
  }

  /**
   * 安装（admin 动作，同步完成）：
   * - discover：本机桌面发现 → 复制 CLI 目录+provider 配置到受管目录 → 冒烟；
   * - remote：http(s) 单文件下载（禁内网段）→ sha256 期望值核对（提供时）→ 落盘 → 冒烟；
   * - local：直引本机路径不复制（managed=0，明示不受漂移保护）→ 冒烟。
   * 任何失败置 error 且不触碰现行解析链（现行解析来自上一 ready 行或降级层）。
   */
  async install(
    sdkType: string,
    input: InstallInput,
  ): Promise<{ ok: boolean; error?: string; record?: EngineRuntimeRecord }> {
    if (sdkType !== "zcode") {
      return { ok: false, error: "内置引擎（anthropic/openai）随平台发版，无需安装" };
    }
    if (input.sourceKind === "remote" && (!input.sourceRef || !/^https?:\/\//i.test(input.sourceRef))) {
      return { ok: false, error: "remote 来源须提供 http(s) 文件 URL" };
    }
    if (input.sourceKind === "local" && !input.sourceRef?.trim()) {
      return { ok: false, error: "local 来源须提供 CLI 入口路径" };
    }
    if (input.sourceKind === "remote" && input.sourceRef) {
      try {
        const host = new URL(input.sourceRef).hostname;
        if (isPrivateNetHost(host)) return { ok: false, error: "禁止下载内网地址（SSRF 防护）" };
      } catch {
        return { ok: false, error: "URL 无法解析" };
      }
    }
    const existing = await this.deps.store.get(sdkType);
    const base: EngineRuntimeRecord = existing ?? {
      sdkType,
      sourceKind: input.sourceKind,
      managed: true,
      status: "missing",
      updatedAt: new Date().toISOString(),
    };
    await this.deps.store.upsert({
      ...base,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      status: "installing",
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    });
    try {
      const prepared =
        input.sourceKind === "discover"
          ? await this.prepareDiscover(sdkType)
          : input.sourceKind === "remote"
            ? await this.prepareRemote(sdkType, input.sourceRef!, input.sha256)
            : await this.prepareLocal(input.sourceRef!);
      const smokeResult = await runSmoke(prepared.cliPath);
      if (!smokeResult.ok) {
        // 冒烟失败：清理受管半成品（直引模式不清理），置 error
        if (prepared.managed && prepared.cleanupDir) {
          rmSync(prepared.cleanupDir, { recursive: true, force: true });
        }
        const now = new Date().toISOString();
        const failed: EngineRuntimeRecord = {
          ...base,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          status: "error",
          lastError: smokeResult.error,
          managed: prepared.managed,
          updatedAt: now,
        };
        await this.deps.store.upsert(failed);
        await this.refreshCache();
        return { ok: false, error: smokeResult.error };
      }
      const now = new Date().toISOString();
      const ready: EngineRuntimeRecord = {
        sdkType,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        pinnedVersion: smokeResult.version,
        installedPath: prepared.cliPath,
        sha256: prepared.managed ? sha256File(prepared.cliPath) : undefined,
        managed: prepared.managed,
        status: "ready",
        lastSmokeAt: now,
        updatedAt: now,
      };
      await this.deps.store.upsert(ready);
      await this.refreshCache();
      await this.recordEvent(
        "engine_installed",
        `${sdkType} 引擎运行时已钉版 v${smokeResult.version ?? "?"}（来源=${input.sourceKind}）`,
      );
      return { ok: true, record: ready };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now = new Date().toISOString();
      await this.deps.store.upsert({
        ...base,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        status: "error",
        lastError: message,
        updatedAt: now,
      });
      await this.refreshCache();
      return { ok: false, error: message };
    }
  }

  /** 漂移检测：ready && managed 行 sha256 复核；不一致 → drifted + system_events（只报警不更换） */
  async checkDrift(): Promise<number> {
    const rows = await this.deps.store.list();
    let drifted = 0;
    for (const row of rows) {
      if (row.status !== "ready" || !row.managed || !row.installedPath) continue;
      if (!existsSync(row.installedPath)) {
        await this.markError(row.sdkType, row, "工件不存在（可能已被删除）");
        drifted += 1;
        continue;
      }
      if (!row.sha256) continue;
      if (sha256File(row.installedPath) !== row.sha256) {
        const now = new Date().toISOString();
        await this.deps.store.upsert({ ...row, status: "drifted", updatedAt: now });
        drifted += 1;
        await this.recordEvent(
          "engine_drifted",
          `${row.sdkType} 引擎工件已被外部修改（sha256 不符），建议在插件页重新安装钉版`,
        );
        this.deps.log.warn({ sdkType: row.sdkType }, "引擎工件漂移（已报警，不自动更换）");
      }
    }
    await this.refreshCache();
    return drifted;
  }

  /** 中断安装清扫：进程崩溃遗留 installing → error（下次启动收口） */
  private async sweepStaleInstalling(): Promise<void> {
    for (const row of await this.deps.store.list()) {
      if (row.status !== "installing") continue;
      await this.markError(row.sdkType, row, "安装被中断（进程重启），请重试");
    }
    await this.refreshCache();
  }

  private async markError(
    sdkType: string,
    row: EngineRuntimeRecord,
    error: string,
  ): Promise<void> {
    await this.deps.store.upsert({
      ...row,
      status: "error",
      lastError: error,
      updatedAt: new Date().toISOString(),
    });
    await this.refreshCache();
  }

  /**
   * discover：探测桌面安装 → 复制 CLI 目录到受管目录 + provider 配置按独立布局补齐
   * （resolveBuiltinProviderConfig 布局② <cliDir>/provider/zcode-builtin.json）→ 自包含可钉版。
   */
  private async prepareDiscover(
    sdkType: string,
  ): Promise<{ cliPath: string; managed: boolean; cleanupDir?: string }> {
    const found = probeZcodeCliFallback();
    if (!found) throw new Error("未在本机发现 ZCode 桌面安装（也可改用 remote/local 来源）");
    let providerConfig: string | undefined;
    try {
      providerConfig = resolveBuiltinProviderConfig(found);
    } catch {
      providerConfig = undefined;
    }
    const version = (await runSmoke(found)).version ?? new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const targetDir = join(this.deps.enginesDir, sdkType, `v${version}`);
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    // CLI 目录整体复制（保留 node_modules 等伴生资产）
    cpSync(dirname(found), targetDir, { recursive: true });
    const copiedCli = join(targetDir, found.split(/[\\/]/).pop() ?? "zcode.cjs");
    if (providerConfig && existsSync(providerConfig)) {
      const providerTarget = join(dirname(copiedCli), "provider", "zcode-builtin.json");
      mkdirSync(dirname(providerTarget), { recursive: true });
      cpSync(providerConfig, providerTarget);
    }
    return { cliPath: copiedCli, managed: true, cleanupDir: targetDir };
  }

  /** remote：单文件下载到受管目录（http(s)+禁内网段已在 install 入口校验） */
  private async prepareRemote(
    sdkType: string,
    url: string,
    expectedSha256?: string,
  ): Promise<{ cliPath: string; managed: boolean; cleanupDir?: string }> {
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const actual = createHash("sha256").update(buf).digest("hex");
    if (expectedSha256 && expectedSha256.trim() && expectedSha256.trim() !== actual) {
      throw new Error(`校验和不符：期望 ${expectedSha256.trim()}，实际 ${actual}`);
    }
    const fileName = url.split("?")[0]!.split("/").pop() ?? "zcode.cjs";
    const targetDir = join(this.deps.enginesDir, sdkType, actual.slice(0, 12));
    mkdirSync(targetDir, { recursive: true });
    const cliPath = join(targetDir, fileName);
    writeFileSync(cliPath, buf);
    return { cliPath, managed: true, cleanupDir: targetDir };
  }

  /** local：直引不复制（managed=0，漂移风险自担） */
  private async prepareLocal(
    ref: string,
  ): Promise<{ cliPath: string; managed: boolean; cleanupDir?: undefined }> {
    const p = ref.trim();
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`路径不存在或不是文件：${p}`);
    return { cliPath: p, managed: false };
  }

  private async recordEvent(type: string, detail: string): Promise<void> {
    await this.deps.systemEvents
      .record({ type, actorId: "system", actorName: "系统", detail })
      .catch((err: unknown) =>
        this.deps.log.warn({ err, type }, "引擎运行时系统事件落库失败"),
      );
  }
}
