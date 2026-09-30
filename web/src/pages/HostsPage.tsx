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
import { apiFetch, fetchMe } from "../lib/auth";

interface Host {
  id: string;
  ownerId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credentialCode: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CredentialTemplate {
  code: string;
  name: string;
  kind: "generic" | "git";
}

const emptyForm = {
  name: "",
  host: "",
  port: "22",
  username: "ubuntu",
  credentialCode: "",
  description: "",
  enabled: true,
};
type FormState = typeof emptyForm;

export function HostsPage() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [templates, setTemplates] = useState<CredentialTemplate[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Host | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Host | null>(null);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      apiFetch("/api/hosts").then((r) => r.json() as Promise<{ hosts?: Host[] }>),
      apiFetch("/api/credential-templates").then(
        (r) => r.json() as Promise<{ templates?: CredentialTemplate[] }>,
      ),
      fetchMe(),
    ])
      .then(([hd, cd, me]) => {
        setHosts(hd.hosts ?? []);
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

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        credentialCode: form.credentialCode,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        enabled: form.enabled,
      };
      const url = editing ? `/api/hosts/${editing.id}` : "/api/hosts";
      const r = await apiFetch(url, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

  const toggleEnabled = async (h: Host, enabled: boolean) => {
    const { id: _i, ownerId: _o, createdAt: _c, updatedAt: _u, ...body } = h;
    const r = await apiFetch(`/api/hosts/${h.id}`, {
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

  const del = async (id: string) => {
    await apiFetch(`/api/hosts/${id}`, { method: "DELETE" });
    setPendingDelete(null);
    refresh();
  };

  const openCreate = () => {
    setForm(emptyForm);
    setFormError(null);
    setCreating(true);
  };
  const openEdit = (h: Host) => {
    setForm({
      name: h.name,
      host: h.host,
      port: String(h.port),
      username: h.username,
      credentialCode: h.credentialCode,
      description: h.description ?? "",
      enabled: h.enabled,
    });
    setFormError(null);
    setEditing(h);
  };
  const closeForm = () => {
    if (saving) return;
    setCreating(false);
    setEditing(null);
  };

  const formOpen = creating || editing !== null;
  const genericCreds = templates.filter((t) => t.kind === "generic");

  return (
    <div className="space-y-4">
      <PageHeader
        title="主机"
        description="SSH 主机资产：登记一次，智能体会话即可用 donger-host 工具诊断与运维（写操作经审批卡）。部署不在此页操作——在对话里说「部署 xx 到 xx」，或用 git 触发器+工作流配置自动部署。"
        actions={isAdmin ? <Button onClick={openCreate}>登记主机</Button> : null}
      />

      {loadError ? (
        <Card className="border-destructive p-4 text-sm text-destructive">{loadError}</Card>
      ) : null}
      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : null}

      {!loading && hosts.length ? (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">名称</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">端点</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">SSH 凭证</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">说明</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">启用</th>
                  {isAdmin ? <th className="px-4 py-2.5 text-right font-medium">操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {hosts.map((h) => (
                  <tr key={h.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">
                      {h.name}
                      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {h.id}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {h.username}@{h.host}:{h.port}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{h.credentialCode}</td>
                    <td className="max-w-[240px] truncate px-4 py-3 text-xs text-muted-foreground">
                      {h.description ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {isAdmin ? (
                        <Switch
                          checked={h.enabled}
                          onCheckedChange={(v) => void toggleEnabled(h, v)}
                        />
                      ) : (
                        <Badge tone={h.enabled ? "success" : "warning"}>
                          {h.enabled ? "启用" : "停用"}
                        </Badge>
                      )}
                    </td>
                    {isAdmin ? (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          className="mr-3 text-xs hover:underline"
                          onClick={() => openEdit(h)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="text-xs text-destructive hover:underline"
                          onClick={() => setPendingDelete(h)}
                        >
                          删除
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      {!loading && !hosts.length && !loadError ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          暂无主机
          {isAdmin ? "，点击右上角「登记主机」添加第一台（SSH 凭证先在凭证页建 generic 模板）" : ""}
        </Card>
      ) : null}

      {formOpen ? (
        <DialogShell
          title={editing ? `编辑主机「${editing.name}」` : "登记主机"}
          subtitle="SSH 端点资产；凭证引用凭证页的 generic 模板（键 private_key / password）"
          onClose={() => closeForm()}
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
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">名称 *</span>
              <Input
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="homedb"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">主机 hostname *</span>
              <Input
                value={form.host}
                onChange={(e) => set({ host: e.target.value })}
                placeholder="homedb.example.com"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">端口 *</span>
              <Input value={form.port} onChange={(e) => set({ port: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">用户名 *</span>
              <Input value={form.username} onChange={(e) => set({ username: e.target.value })} />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-xs text-muted-foreground">SSH 凭证（generic 模板）*</span>
              <Select
                value={form.credentialCode}
                onChange={(e) => set({ credentialCode: e.target.value })}
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
              <span className="text-xs text-muted-foreground">说明（可选）</span>
              <Input
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
                placeholder="stock-analysis 部署机；ClickHouse 在跑"
              />
            </label>
            <div className="col-span-2 flex items-center gap-2 pt-1">
              <Switch checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
              <span className="text-xs">启用（停用后会话工具不可用）</span>
            </div>
            {formError ? (
              <div className="col-span-2 text-xs text-destructive">{formError}</div>
            ) : null}
          </div>
        </DialogShell>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除主机「${pendingDelete?.name ?? ""}」？`}
        description="仅删除资产登记与凭证引用，不影响主机上的任何服务。"
        confirmText="删除"
        destructive
        busy={false}
        onConfirm={() => void del(pendingDelete?.id ?? "")}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
