import { useCallback, useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { DialogShell } from "../components/ui/dialog-shell";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { apiFetch, fetchMe } from "../lib/auth";

interface DeployStep {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  outputTail?: string;
}

interface DeployOrder {
  id: string;
  targetId: string;
  trigger: "poll" | "manual" | "agent";
  ref?: string;
  sha?: string;
  status: "running" | "success" | "failed";
  steps: DeployStep[];
  error?: string;
  startedAt: string;
  finishedAt?: string | null;
}

interface DeployTarget {
  id: string;
  ownerId: string;
  name: string;
  service: string;
  provider: "jihulab" | "github" | "gitee";
  repoUrl: string;
  branch: string;
  gitCredentialCode?: string;
  ssh: { host: string; port: number; username: string; credentialCode: string };
  workdir: string;
  prepareCommands: string[];
  restartCommands: string[];
  healthCheck?: { cmd: string; expectContains?: string };
  autoDeploy: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSuccessSha?: string | null;
}

interface CredentialTemplate {
  code: string;
  name: string;
  kind: "generic" | "git";
}

const emptyForm = {
  name: "",
  service: "",
  provider: "gitee" as DeployTarget["provider"],
  repoUrl: "",
  branch: "master",
  gitCredentialCode: "",
  sshHost: "",
  sshPort: "22",
  sshUsername: "ubuntu",
  sshCredentialCode: "",
  workdir: "",
  prepareCommands: "",
  restartCommands: "",
  healthCmd: "",
  healthExpect: "",
  autoDeploy: false,
  enabled: true,
};

type FormState = typeof emptyForm;

function formFromTarget(t: DeployTarget): FormState {
  return {
    name: t.name,
    service: t.service,
    provider: t.provider,
    repoUrl: t.repoUrl,
    branch: t.branch,
    gitCredentialCode: t.gitCredentialCode ?? "",
    sshHost: t.ssh.host,
    sshPort: String(t.ssh.port),
    sshUsername: t.ssh.username,
    sshCredentialCode: t.ssh.credentialCode,
    workdir: t.workdir,
    prepareCommands: t.prepareCommands.join("\n"),
    restartCommands: t.restartCommands.join("\n"),
    healthCmd: t.healthCheck?.cmd ?? "",
    healthExpect: t.healthCheck?.expectContains ?? "",
    autoDeploy: t.autoDeploy,
    enabled: t.enabled,
  };
}

function targetPayload(f: FormState) {
  const lines = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    name: f.name.trim(),
    service: f.service.trim(),
    provider: f.provider,
    repoUrl: f.repoUrl.trim(),
    branch: f.branch.trim(),
    ...(f.gitCredentialCode ? { gitCredentialCode: f.gitCredentialCode } : {}),
    ssh: {
      host: f.sshHost.trim(),
      port: Number(f.sshPort) || 22,
      username: f.sshUsername.trim(),
      credentialCode: f.sshCredentialCode,
    },
    workdir: f.workdir.trim(),
    prepareCommands: lines(f.prepareCommands),
    restartCommands: lines(f.restartCommands),
    ...(f.healthCmd.trim()
      ? {
          healthCheck: {
            cmd: f.healthCmd.trim(),
            ...(f.healthExpect.trim() ? { expectContains: f.healthExpect.trim() } : {}),
          },
        }
      : {}),
    autoDeploy: f.autoDeploy,
    enabled: f.enabled,
  };
}

function StatusBadge({ status }: { status: DeployOrder["status"] }) {
  const tone = status === "success" ? "success" : status === "failed" ? "danger" : "warning";
  const label = status === "success" ? "成功" : status === "failed" ? "失败" : "执行中";
  return <Badge tone={tone}>{label}</Badge>;
}

function StepList({ steps }: { steps: DeployStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="mt-1 space-y-1.5">
      {steps.map((s) => (
        <div key={s.name} className="rounded-md border border-border bg-muted/30 p-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">
              {s.name}{" "}
              <span className={s.exitCode === 0 ? "text-emerald-500" : "text-destructive"}>
                exit={s.exitCode}
              </span>
            </span>
            <span className="text-muted-foreground">
              {s.command.slice(0, 80)}
              {s.command.length > 80 ? "…" : ""} · {s.durationMs}ms
            </span>
          </div>
          {s.outputTail ? (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
              {s.outputTail}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function DeployPage() {
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [templates, setTemplates] = useState<CredentialTemplate[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Record<string, DeployOrder[]>>({});
  const [deploying, setDeploying] = useState<string | null>(null);
  const [resultOrder, setResultOrder] = useState<DeployOrder | null>(null);

  const [editing, setEditing] = useState<DeployTarget | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeployTarget | null>(null);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      apiFetch("/api/deploy-targets").then(
        (r) => r.json() as Promise<{ targets?: DeployTarget[] }>,
      ),
      apiFetch("/api/credential-templates").then(
        (r) => r.json() as Promise<{ templates?: CredentialTemplate[] }>,
      ),
      fetchMe(),
    ])
      .then(([td, cd, me]) => {
        setTargets(td.targets ?? []);
        setTemplates(cd.templates ?? []);
        setIsAdmin(me?.role === "admin");
      })
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadOrders = async (targetId: string) => {
    if (expanded[targetId]) {
      setExpanded((m) => {
        const next = { ...m };
        delete next[targetId];
        return next;
      });
      return;
    }
    const r = await apiFetch(`/api/deploy-orders/${targetId}/orders`);
    const data = (await r.json()) as { orders?: DeployOrder[] };
    setExpanded((m) => ({ ...m, [targetId]: data.orders ?? [] }));
  };

  const deploy = async (t: DeployTarget) => {
    if (!confirm(`部署「${t.name}」？将在 ${t.ssh.host} 上执行剧本并重启服务。`)) return;
    setDeploying(t.id);
    try {
      const r = await apiFetch(`/api/deploy-targets/${t.id}/deploy`, { method: "POST" });
      const data = (await r.json()) as DeployOrder & { error?: string };
      setResultOrder(data);
      if (expanded[t.id]) await loadOrders(t.id);
      refresh();
    } catch (e) {
      alert(`部署请求失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeploying(null);
    }
  };

  const toggleEnabled = async (t: DeployTarget, enabled: boolean) => {
    const { lastSuccessSha: _drop, ...body } = t;
    const r = await apiFetch(`/api/deploy-targets/${t.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, enabled }),
    });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      alert(`保存失败：${data.error ?? r.status}`);
      return;
    }
    refresh();
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const url = editing ? `/api/deploy-targets/${editing.id}` : "/api/deploy-targets";
      const r = await apiFetch(url, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetPayload(form)),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        setFormError(data.error ?? data.message ?? `保存失败（${r.status}）`);
        return;
      }
      setCreating(false);
      setEditing(null);
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const del = async (id: string) => {
    await apiFetch(`/api/deploy-targets/${id}`, { method: "DELETE" });
    setPendingDelete(null);
    refresh();
  };

  const openCreate = () => {
    setForm(emptyForm);
    setFormError(null);
    setCreating(true);
  };
  const closeForm = () => {
    if (saving) return;
    setCreating(false);
    setEditing(null);
  };
  const openEdit = (t: DeployTarget) => {
    setForm(formFromTarget(t));
    setFormError(null);
    setEditing(t);
  };

  const formDialog = creating || editing !== null;
  const genericCreds = templates.filter((t) => t.kind === "generic");
  const gitCreds = templates.filter((t) => t.kind === "git");

  return (
    <div className="space-y-4">
      <PageHeader
        title="部署"
        description="部署目标（git 仓库 → SSH 目标机剧本执行）与部署历史；轮询发现新提交时按目标设置自动部署或仅通知。"
        actions={isAdmin ? <Button onClick={openCreate}>新建目标</Button> : null}
      />

      {loadError ? (
        <Card className="border-destructive p-4 text-sm text-destructive">{loadError}</Card>
      ) : null}
      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : null}

      {!loading && targets.length ? (
        <div className="space-y-3">
          {targets.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-[180px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge tone={t.enabled ? "success" : "warning"}>
                      {t.enabled ? "已启用" : "已停用"}
                    </Badge>
                    <Badge tone={t.autoDeploy ? "info" : undefined}>
                      {t.autoDeploy ? "自动部署" : "仅通知"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {t.service} · {t.provider}:
                      {t.repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "")}#{t.branch} ·{" "}
                      {t.ssh.username}@{t.ssh.host} · {t.workdir}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    最近成功：{t.lastSuccessSha ? t.lastSuccessSha.slice(0, 8) : "无"}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deploying !== null || !t.enabled}
                    onClick={() => void deploy(t)}
                  >
                    {deploying === t.id ? "部署执行中…" : "立即部署"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void loadOrders(t.id)}>
                    {expanded[t.id] ? "收起历史" : "部署历史"}
                  </Button>
                  {isAdmin ? (
                    <>
                      <Switch
                        checked={t.enabled}
                        onCheckedChange={(v) => void toggleEnabled(t, v)}
                      />
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>
                        编辑
                      </Button>
                      <button
                        type="button"
                        className="text-xs text-destructive hover:underline"
                        onClick={() => setPendingDelete(t)}
                      >
                        删除
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {expanded[t.id] ? (
                <div className="mt-3 border-t border-border pt-3">
                  {expanded[t.id]?.length ? (
                    <div className="space-y-2">
                      {expanded[t.id]?.map((o) => (
                        <details key={o.id} className="rounded-md border border-border p-2">
                          <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
                            <StatusBadge status={o.status} />
                            <span>{new Date(o.startedAt).toLocaleString()}</span>
                            <span className="text-muted-foreground">
                              触发={o.trigger} · ref={o.ref ?? "-"}
                              {o.sha ? ` @${o.sha.slice(0, 8)}` : ""}
                            </span>
                            {o.error ? (
                              <span className="text-destructive">{o.error.slice(0, 120)}</span>
                            ) : null}
                          </summary>
                          <StepList steps={o.steps} />
                        </details>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">暂无部署记录</div>
                  )}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}
      {!loading && !targets.length && !loadError ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          暂无部署目标{isAdmin ? "，点击右上角「新建目标」登记第一个服务" : ""}
        </Card>
      ) : null}

      {formDialog ? (
        <DialogShell
          title={editing ? `编辑目标「${editing.name}」` : "新建部署目标"}
          subtitle="剧本命令在目标机经 SSH 逐条执行，支持变量 {ref} {branch} {workdir} {service}"
          onClose={() => closeForm()}
          className="max-w-2xl"
          footer={
            <>
              <Button variant="outline" disabled={saving} onClick={() => closeForm()}>
                取消
              </Button>
              <Button disabled={saving} onClick={() => void save()}>
                {saving ? "保存中…" : "保存"}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">名称 *</span>
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  服务标识（{`{service}`} 变量）*
                </span>
                <Input
                  value={form.service}
                  onChange={(e) => set({ service: e.target.value })}
                  placeholder="stock-analysis"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">代码平台 *</span>
                <Select
                  value={form.provider}
                  onChange={(e) => set({ provider: e.target.value as DeployTarget["provider"] })}
                >
                  <option value="gitee">gitee</option>
                  <option value="jihulab">jihulab / GitLab</option>
                  <option value="github">github</option>
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">git 凭证（私有仓库必填）</span>
                <Select
                  value={form.gitCredentialCode}
                  onChange={(e) => set({ gitCredentialCode: e.target.value })}
                >
                  <option value="">（公共仓库，匿名）</option>
                  {gitCreds.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}（{c.code}）
                    </option>
                  ))}
                </Select>
              </label>
              <label className="col-span-2 space-y-1">
                <span className="text-xs text-muted-foreground">仓库 HTTPS 地址 *</span>
                <Input
                  value={form.repoUrl}
                  onChange={(e) => set({ repoUrl: e.target.value })}
                  placeholder="https://gitee.com/renkee/stock-analysis.git"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">分支 *</span>
                <Input value={form.branch} onChange={(e) => set({ branch: e.target.value })} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">目标机部署目录 *</span>
                <Input
                  value={form.workdir}
                  onChange={(e) => set({ workdir: e.target.value })}
                  placeholder="/var/www/stock-analysis"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">SSH 主机 *</span>
                <Input value={form.sshHost} onChange={(e) => set({ sshHost: e.target.value })} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">端口 *</span>
                  <Input value={form.sshPort} onChange={(e) => set({ sshPort: e.target.value })} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">用户名 *</span>
                  <Input
                    value={form.sshUsername}
                    onChange={(e) => set({ sshUsername: e.target.value })}
                  />
                </label>
              </div>
              <label className="col-span-2 space-y-1">
                <span className="text-xs text-muted-foreground">
                  SSH 凭证（generic 模板，private_key/password）*
                </span>
                <Select
                  value={form.sshCredentialCode}
                  onChange={(e) => set({ sshCredentialCode: e.target.value })}
                >
                  <option value="">（请选择）</option>
                  {genericCreds.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}（{c.code}）
                    </option>
                  ))}
                </Select>
              </label>
              <label className="col-span-2 space-y-1">
                <span className="text-xs text-muted-foreground">
                  部署剧本（每行一条，顺序执行，任一失败即终止）*
                </span>
                <Textarea
                  rows={4}
                  mono
                  value={form.prepareCommands}
                  onChange={(e) => set({ prepareCommands: e.target.value })}
                  placeholder={
                    "cd {workdir} && git pull origin {branch}\nsudo systemctl restart stock"
                  }
                />
              </label>
              <label className="col-span-2 space-y-1">
                <span className="text-xs text-muted-foreground">
                  重启剧本（会话 service_restart 工具用，可空）
                </span>
                <Textarea
                  rows={2}
                  mono
                  value={form.restartCommands}
                  onChange={(e) => set({ restartCommands: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">健康检查命令（可空）</span>
                <Input
                  value={form.healthCmd}
                  onChange={(e) => set({ healthCmd: e.target.value })}
                  placeholder="curl -sf http://127.0.0.1:8200/docs"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">健康检查输出须包含（可空）</span>
                <Input
                  value={form.healthExpect}
                  onChange={(e) => set({ healthExpect: e.target.value })}
                />
              </label>
              <div className="col-span-2 flex items-center gap-6 pt-1">
                <div className="flex items-center gap-2">
                  <Switch checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
                  <span className="text-xs">启用（轮询/会话工具可见）</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.autoDeploy}
                    onCheckedChange={(v) => set({ autoDeploy: v })}
                  />
                  <span className="text-xs">自动部署（关=发现新提交仅通知）</span>
                </div>
              </div>
            </div>
            {formError ? <div className="text-xs text-destructive">{formError}</div> : null}
          </div>
        </DialogShell>
      ) : null}

      {resultOrder ? (
        <DialogShell
          title={
            resultOrder.status === "success"
              ? "部署成功"
              : resultOrder.status === "failed"
                ? "部署失败"
                : "部署执行中"
          }
          subtitle={`触发=${resultOrder.trigger} · ref=${resultOrder.ref ?? "-"}${resultOrder.sha ? ` @${resultOrder.sha.slice(0, 8)}` : ""}`}
          onClose={() => setResultOrder(null)}
          className="max-w-2xl"
          footer={
            <Button variant="outline" onClick={() => setResultOrder(null)}>
              关闭
            </Button>
          }
        >
          {resultOrder.error ? (
            <div className="mb-2 rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive">
              {resultOrder.error}
            </div>
          ) : null}
          <StepList steps={resultOrder.steps} />
        </DialogShell>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除部署目标「${pendingDelete?.name ?? ""}」？`}
        description="仅删除登记信息与轮询，不影响目标机上的服务；历史部署单保留。"
        confirmText="删除"
        destructive
        busy={false}
        onConfirm={() => void del(pendingDelete?.id ?? "")}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
