import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import {
  type EngineInstallInput,
  type EngineRuntimeDTO,
  type EngineRuntimeStatus,
  fetchAdminPlugins,
  fetchEngineRuntimes,
  installEngineRuntime,
  type PluginView,
  setPluginEnabled,
  smokeEngineRuntime,
} from "../lib/plugins";

/**
 * 插件注册表（admin，specs/2026-10-11-plugin-system-design.md §4）：
 * 平台全部功能模块的治理底账——引擎/能力/扩展包三分区盘点。
 * 引擎启停/工件安装随 M1 开放；能力模块启停随 M2 开放；扩展包随 M3。
 */

const ENGINE_STATUS_LABEL: Record<EngineRuntimeDTO["status"], string> = {
  missing: "未钉版",
  installing: "安装中",
  ready: "已钉版",
  error: "异常",
  drifted: "已漂移",
  disabled: "已停用",
};

/** M2 已开放启停的能力模块（specs §9.6）；其余 stoppable 行灰置「随后续版本开放」 */
const M2_TOGGLEABLE = new Set([
  "mcp-servers",
  "connectors",
  "host-exec",
  "channel.dingtalk",
  "workflows",
  "event-sources",
]);

function ToggleButton({
  enabled,
  busy,
  onToggle,
}: {
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={busy}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        enabled ? "bg-primary" : "bg-muted-foreground/40"
      }`}
      title={enabled ? "点击停用" : "点击启用"}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
          enabled ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function InstallDialog({
  busy,
  error,
  onInstall,
  onClose,
}: {
  busy: boolean;
  error: string;
  onInstall: (input: EngineInstallInput) => void;
  onClose: () => void;
}) {
  const [sourceKind, setSourceKind] = useState<EngineInstallInput["sourceKind"]>("discover");
  const [sourceRef, setSourceRef] = useState("");
  const [sha256, setSha256] = useState("");
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3.5">
      <div className="text-sm font-medium">安装 ZCode 运行时</div>
      <div className="space-y-1.5 text-xs">
        {(
          [
            ["discover", "本机发现（推荐）", "检测桌面安装并复制到受管目录钉版，一键获得漂移保护"],
            ["remote", "远程下载", "http(s) 文件 URL（可选填期望 sha256，不符拒装）"],
            ["local", "本地路径直引", "不复制，不受漂移保护（风险自担）"],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="engine-install-source"
              className="mt-0.5"
              checked={sourceKind === value}
              onChange={() => setSourceKind(value)}
            />
            <span>
              <span className="text-[13px]">{label}</span>
              <span className="ml-1 text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      {sourceKind === "remote" ? (
        <div className="space-y-2">
          <Input
            mono
            placeholder="https://…/zcode.cjs"
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
          />
          <Input
            mono
            placeholder="期望 sha256（可留空=安装时计算）"
            value={sha256}
            onChange={(e) => setSha256(e.target.value)}
          />
        </div>
      ) : null}
      {sourceKind === "local" ? (
        <Input
          mono
          placeholder="CLI 入口绝对路径（如 C:/…/zcode.cjs）"
          value={sourceRef}
          onChange={(e) => setSourceRef(e.target.value)}
        />
      ) : null}
      {error ? (
        <div className="rounded bg-destructive-soft p-2 text-xs text-destructive">{error}</div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={busy || (sourceKind !== "discover" && !sourceRef.trim())}
          onClick={() =>
            onInstall({
              sourceKind,
              ...(sourceKind !== "discover" && sourceRef.trim()
                ? { sourceRef: sourceRef.trim() }
                : {}),
              ...(sha256.trim() ? { sha256: sha256.trim() } : {}),
            })
          }
        >
          {busy ? "安装中…" : "安装"}
        </Button>
      </div>
    </div>
  );
}

function EngineRows({
  runtimes,
  resolution,
  plugins,
  onChanged,
}: {
  runtimes: EngineRuntimeDTO[];
  resolution: EngineRuntimeStatus["resolution"];
  plugins: PluginView[];
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState("");
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installError, setInstallError] = useState("");

  const act = async (id: string, fn: () => Promise<void>, okText: string) => {
    setBusyId(id);
    setMsg(null);
    try {
      await fn();
      setMsg({ id, ok: true, text: okText });
      onChanged();
    } catch (reason: unknown) {
      setMsg({
        id,
        ok: false,
        text: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          引擎运行时是平台级资产：钉版后不随第三方自动更新漂移；停用引擎的会话将显性报错（不静默换引擎）
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setInstallOpen(true);
            setInstallError("");
          }}
        >
          安装 ZCode 运行时
        </Button>
      </div>
      {runtimes.map((rt) => {
        const plugin = plugins.find((p) => p.id === `engine.${rt.sdkType}`);
        const res = resolution[rt.sdkType];
        const id = rt.sdkType;
        return (
          <div
            key={rt.sdkType}
            className="space-y-2 rounded-lg border border-border bg-background px-3.5 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {plugin?.title ?? `引擎 ${rt.sdkType}`}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {rt.sourceKind === "bundled" ? "内置 · 即装即用" : `来源：${rt.sourceKind}`}
                  </span>
                  {rt.sdkType !== "anthropic" && rt.sdkType !== "openai" ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        rt.status === "ready"
                          ? "bg-success-soft text-success"
                          : rt.status === "drifted" || rt.status === "error"
                            ? "bg-destructive-soft text-destructive"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {ENGINE_STATUS_LABEL[rt.status]}
                      {rt.pinnedVersion ? ` · v${rt.pinnedVersion}` : ""}
                    </span>
                  ) : null}
                  {plugin ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        plugin.enabled
                          ? "bg-success-soft text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {plugin.enabled ? "已启用" : "已停用"}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-0.5 text-[11px] text-muted-foreground">
                  {res ? (
                    <p className="truncate font-mono" title={res.path}>
                      解析：{res.path}
                      {res.source === "fallback" ? "（桌面候选降级 · 未钉版，随更新漂移）" : ""}
                    </p>
                  ) : null}
                  {rt.installedPath ? (
                    <p className="truncate font-mono" title={rt.installedPath}>
                      工件：{rt.installedPath}
                      {rt.sha256 ? ` · sha256:${rt.sha256.slice(0, 8)}` : ""}
                      {rt.managed ? "" : " · 未受管（漂移风险自担）"}
                    </p>
                  ) : null}
                  {rt.lastError ? <p className="text-destructive">{rt.lastError}</p> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {rt.sdkType === "zcode" && rt.installedPath ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyId === id}
                    onClick={() =>
                      act(
                        id,
                        async () => {
                          await smokeEngineRuntime(id);
                        },
                        "冒烟通过",
                      )
                    }
                  >
                    {busyId === id ? "冒烟中…" : "重新冒烟"}
                  </Button>
                ) : null}
                {plugin && plugin.stoppable ? (
                  <ToggleButton
                    enabled={plugin.enabled}
                    busy={busyId === plugin.id}
                    onToggle={() =>
                      act(
                        plugin.id,
                        async () => {
                          const outcome = await setPluginEnabled(plugin.id, !plugin.enabled);
                          if (!outcome.ok) throw new Error(outcome.blockers.join("；"));
                        },
                        plugin.enabled ? "已停用（指向该引擎的会话将报错）" : "已启用",
                      )
                    }
                  />
                ) : null}
              </div>
            </div>
            {msg && (msg.id === id || msg.id === plugin?.id) ? (
              <div
                className={`rounded p-2 text-xs ${
                  msg.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"
                }`}
              >
                {msg.text}
              </div>
            ) : null}
          </div>
        );
      })}
      {installOpen ? (
        <InstallDialog
          busy={busyId === "install"}
          error={installError}
          onClose={() => setInstallOpen(false)}
          onInstall={(input) => {
            setInstallError("");
            setBusyId("install");
            installEngineRuntime("zcode", input)
              .then(() => {
                setInstallOpen(false);
                setMsg({ id: "zcode", ok: true, text: "安装完成：ZCode 运行时已钉版" });
                onChanged();
              })
              .catch((reason: unknown) =>
                setInstallError(reason instanceof Error ? reason.message : String(reason)),
              )
              .finally(() => setBusyId(""));
          }}
        />
      ) : null}
    </div>
  );
}

function StatusBadge({ p }: { p: PluginView }) {
  if (p.status === "ready") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        正常
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1 rounded-full bg-destructive-soft px-2 py-0.5 text-[11px] font-medium text-destructive"
      title={p.error}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
      {p.status === "missing" ? "manifest 缺失" : "异常"}
    </span>
  );
}

function CapabilityRow({
  p,
  all,
  onToggle,
  busy,
}: {
  p: PluginView;
  all: PluginView[];
  onToggle: (p: PluginView) => void;
  busy: boolean;
}) {
  const dependents = all.filter((o) => o.requires.includes(p.id)).map((o) => o.title);
  const requiresTitles = p.requires.map((id) => all.find((o) => o.id === id)?.title ?? id);
  const toggleOpen = M2_TOGGLEABLE.has(p.id);
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background px-3.5 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{p.title}</span>
          {p.core ? (
            <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              核心
            </span>
          ) : null}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            内置
          </span>
        </div>
        {p.description ? <p className="text-xs text-muted-foreground">{p.description}</p> : null}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-mono">{p.id}</span>
          {requiresTitles.length > 0 ? <span>依赖：{requiresTitles.join("、")}</span> : null}
          {dependents.length > 0 ? <span>被依赖：{dependents.join("、")}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge p={p} />
        {toggleOpen ? (
          <ToggleButton enabled={p.enabled} busy={busy} onToggle={() => onToggle(p)} />
        ) : (
          <span className="text-[10px] text-muted-foreground">启停随后续版本开放</span>
        )}
      </div>
    </div>
  );
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineRuntimeStatus | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [pageMsg, setPageMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    setError("");
    fetchAdminPlugins()
      .then(setPlugins)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    fetchEngineRuntimes()
      .then(setEngineStatus)
      .catch(() => setEngineStatus(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const togglePlugin = async (p: PluginView) => {
    setBusyId(p.id);
    setPageMsg(null);
    try {
      const outcome = await setPluginEnabled(p.id, !p.enabled);
      if (!outcome.ok) throw new Error(outcome.blockers.join("；"));
      setPageMsg({ ok: true, text: `「${p.title}」已${p.enabled ? "停用" : "启用"}` });
      load();
    } catch (reason: unknown) {
      setPageMsg({
        ok: false,
        text: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusyId("");
    }
  };

  const all = plugins ?? [];
  const engines = all.filter((p) => p.kind === "engine");
  const agentCaps = all.filter((p) => p.kind === "capability" && p.scope === "agent");
  const platformCaps = all.filter((p) => p.kind === "capability" && p.scope !== "agent");
  const drifted = (engineStatus?.runtimes ?? []).some((r) => r.status === "drifted");

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
      <PageHeader
        title="插件"
        description="平台功能模块的注册表与治理底账：引擎运行时、能力模块与扩展包。模块默认全量预装；停用是显性动作，被依赖模块须先停依赖方"
      />
      {drifted ? (
        <div className="rounded bg-destructive-soft p-3 text-sm text-destructive">
          ⚠ 引擎工件已被外部修改（sha256 不符），建议重新安装钉版。详见下方引擎分区与系统事件。
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center justify-between gap-3 rounded bg-destructive-soft p-3 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" className="text-xs underline" onClick={load}>
            重试
          </button>
        </div>
      ) : null}
      {pageMsg ? (
        <div
          className={`rounded p-2.5 text-sm ${
            pageMsg.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"
          }`}
        >
          {pageMsg.text}
        </div>
      ) : null}
      {!plugins ? (
        <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          加载中…
        </div>
      ) : (
        <>
          <section className="space-y-2 rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">执行引擎</h2>
            {engineStatus ? (
              <EngineRows
                runtimes={engineStatus.runtimes}
                resolution={engineStatus.resolution}
                plugins={engines}
                onChanged={load}
              />
            ) : (
              <p className="text-xs text-muted-foreground">引擎运行时状态不可用（服务未启用）</p>
            )}
          </section>
          <section className="space-y-2 rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">能力模块 · 智能体相关</h2>
            <p className="text-xs text-muted-foreground">
              智能体配置与执行面的功能模块；「核心+不可停用」为安全内核/主干。停用=执行面跳过、配置保留（读照常、写
              409）
            </p>
            <div className="space-y-2">
              {agentCaps.map((p) => (
                <CapabilityRow
                  key={p.id}
                  p={p}
                  all={all}
                  onToggle={togglePlugin}
                  busy={busyId === p.id}
                />
              ))}
            </div>
          </section>
          <section className="space-y-2 rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">能力模块 · 平台级</h2>
            <p className="text-xs text-muted-foreground">
              渠道/自动化/可观测等平台级模块；停用需先停依赖方
            </p>
            <div className="space-y-2">
              {platformCaps.map((p) => (
                <CapabilityRow
                  key={p.id}
                  p={p}
                  all={all}
                  onToggle={togglePlugin}
                  busy={busyId === p.id}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
