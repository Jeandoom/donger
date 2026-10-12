// 主机执行策略管理弹窗（specs/2026-10-12-host-exec-policy-design.md §8.1 M2）：
// 单台主机视角——本主机（hostCode 精确）规则可增删改启停，'*' 通配规则只读展示
// （它们作用于所有主机，编辑入口放在任意主机都能看到，就地管理即可）。
import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { DialogShell } from "../../components/ui/dialog-shell";
import { FormField } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import {
  type HostExecPolicyDTO,
  type HostExecPolicyInput,
  createHostExecPolicy,
  deleteHostExecPolicy,
  fetchHostExecPolicies,
  setHostExecPolicyEnabled,
  updateHostExecPolicy,
} from "../../lib/hostPolicy";

type FormState = {
  id: string | null;
  tool: HostExecPolicyInput["tool"];
  scopeKind: "global" | "agent";
  scopeRef: string;
  matchKind: "prefix" | "pattern";
  matchValue: string;
  decision: HostExecPolicyInput["decision"];
  unattended: HostExecPolicyInput["unattended"];
  note: string;
};

export function HostPolicyDialog(props: {
  hostCode: string;
  hostName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [policies, setPolicies] = useState<HostExecPolicyDTO[] | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<HostExecPolicyDTO | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await fetchHostExecPolicies();
      setPolicies(data.policies);
      setAgents(data.agents);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async () => {
    if (!form) return;
    const input: HostExecPolicyInput = {
      hostCode: props.hostCode,
      tool: form.tool,
      scopeKind: form.scopeKind,
      ...(form.scopeKind === "agent" ? { scopeRef: form.scopeRef } : {}),
      matchKind: form.matchKind,
      matchValue: form.matchValue,
      decision: form.decision,
      unattended: form.unattended,
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    };
    if (form.scopeKind === "agent" && !form.scopeRef) {
      setFormError("agent 生效域必须选择智能体");
      return;
    }
    if (!form.matchValue.trim()) {
      setFormError(form.matchKind === "prefix" ? "至少一条前缀" : "正则不能为空");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (form.id) await updateHostExecPolicy(form.id, input);
      else await createHostExecPolicy(input);
      setForm(null);
      await reload();
      props.onChanged();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: HostExecPolicyDTO) => {
    try {
      await setHostExecPolicyEnabled(rule.id, !rule.enabled);
      await reload();
      props.onChanged();
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteHostExecPolicy(pendingDelete.id);
      setPendingDelete(null);
      await reload();
      props.onChanged();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const mine = (policies ?? []).filter((p) => p.hostCode === props.hostCode);
  const wildcard = (policies ?? []).filter((p) => p.hostCode === "*");

  return (
    <DialogShell
      title={`执行策略：${props.hostName}`}
      subtitle={`主机 ${props.hostCode}；deny 黑名单先行于一切 allow，未命中默认回审批卡`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={props.onClose}>
            关闭
          </Button>
          {!form ? (
            <Button
              size="sm"
              onClick={() => {
                setFormError(null);
                setForm({
                  id: null,
                  tool: "host_exec",
                  scopeKind: "global",
                  scopeRef: "",
                  matchKind: "prefix",
                  matchValue: "",
                  decision: "allow",
                  unattended: "inherit",
                  note: "",
                });
              }}
            >
              新增策略
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : null}

        {form ? (
          <div className="rounded-xl border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="工具">
                <Select
                  value={form.tool}
                  onChange={(e) =>
                    setForm({ ...form, tool: e.target.value as FormState["tool"] })
                  }
                >
                  <option value="host_exec">host_exec（任意命令）</option>
                  <option value="host_logs_clean">host_logs_clean（日志截断）</option>
                  <option value="*">两者</option>
                </Select>
              </FormField>
              <FormField label="生效域">
                <div className="flex gap-2">
                  <Select
                    value={form.scopeKind}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        scopeKind: e.target.value as FormState["scopeKind"],
                        scopeRef: "",
                      })
                    }
                  >
                    <option value="global">全局（所有使用者）</option>
                    <option value="agent">限定智能体</option>
                  </Select>
                  {form.scopeKind === "agent" ? (
                    <Select
                      value={form.scopeRef}
                      onChange={(e) => setForm({ ...form, scopeRef: e.target.value })}
                    >
                      <option value="">选择智能体…</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                </div>
              </FormField>
              <FormField label="匹配方式">
                <Select
                  value={form.matchKind}
                  onChange={(e) =>
                    setForm({ ...form, matchKind: e.target.value as FormState["matchKind"] })
                  }
                >
                  <option value="prefix">前缀（命令段以它开头，带防逃逸检查）</option>
                  <option value="pattern">正则（对完整命令匹配）</option>
                </Select>
              </FormField>
              <FormField label="决策">
                <Select
                  value={form.decision}
                  onChange={(e) =>
                    setForm({ ...form, decision: e.target.value as FormState["decision"] })
                  }
                >
                  <option value="allow">allow（免审批执行）</option>
                  <option value="ask">ask（回审批卡）</option>
                  <option value="deny">deny（直接拒绝，黑名单）</option>
                </Select>
              </FormField>
              <FormField
                label={form.matchKind === "prefix" ? "前缀集（每行一条）" : "正则"}
                hint={form.matchKind === "prefix" ? "组合命令须逐段命中；>/dev/null 之外的重定向与命令替换恒回审批" : "对完整命令 test；≤200 字符"}
              >
                {form.matchKind === "prefix" ? (
                  <Textarea
                    mono
                    rows={3}
                    value={form.matchValue}
                    placeholder={"systemctl is-active\ncurl -s"}
                    spellCheck={false}
                    onChange={(e) => setForm({ ...form, matchValue: e.target.value })}
                  />
                ) : (
                  <Input
                    mono
                    value={form.matchValue}
                    placeholder="^git -C /srv/\w+ pull"
                    spellCheck={false}
                    onChange={(e) => setForm({ ...form, matchValue: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="无人值守档" hint="仅对 allow/ask 条目有意义；skip 随 M3 开放">
                <Select
                  value={form.unattended}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      unattended: e.target.value as FormState["unattended"],
                    })
                  }
                >
                  <option value="inherit">跟随决策</option>
                  <option value="allow">无人值守也放行</option>
                </Select>
              </FormField>
              <FormField label="备注（可选）">
                <Input
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                />
              </FormField>
            </div>
            {formError ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {formError}
              </p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? "保存中…" : form.id ? "保存修改" : "创建"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setForm(null);
                  setFormError(null);
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <div className="text-[13px] font-semibold">
            本主机的规则 <Badge>{mine.length}</Badge>
          </div>
          {policies === null ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : mine.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
              本主机没有专属规则——未命中时一律回审批卡；host_status 等只读诊断工具不受影响。
            </p>
          ) : (
            mine.map((rule) => (
              <PolicyRow
                key={rule.id}
                rule={rule}
                agentName={agents.find((a) => a.id === rule.scopeRef)?.name}
                onToggle={() => void toggle(rule)}
                onEdit={() => {
                  setFormError(null);
                  setForm({
                    id: rule.id,
                    tool: rule.tool,
                    scopeKind: rule.scopeKind === "agent" ? "agent" : "global",
                    scopeRef: rule.scopeRef ?? "",
                    matchKind: rule.matchKind,
                    matchValue: rule.matchValue,
                    decision: rule.decision,
                    unattended: rule.unattended === "skip" ? "inherit" : rule.unattended,
                    note: rule.note ?? "",
                  });
                }}
                onDelete={() => {
                  setDeleteError(null);
                  setPendingDelete(rule);
                }}
              />
            ))
          )}
        </div>

        {wildcard.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-[13px] font-semibold text-muted-foreground">
              全部主机通配（'*'）规则 <Badge>{wildcard.length}</Badge>
            </div>
            {wildcard.map((rule) => (
              <PolicyRow
                key={rule.id}
                rule={rule}
                wildcard
                agentName={agents.find((a) => a.id === rule.scopeRef)?.name}
                onToggle={() => void toggle(rule)}
                onEdit={() => {
                  setFormError(null);
                  setForm({
                    id: rule.id,
                    tool: rule.tool,
                    scopeKind: rule.scopeKind === "agent" ? "agent" : "global",
                    scopeRef: rule.scopeRef ?? "",
                    matchKind: rule.matchKind,
                    matchValue: rule.matchValue,
                    decision: rule.decision,
                    unattended: rule.unattended === "skip" ? "inherit" : rule.unattended,
                    note: rule.note ?? "",
                  });
                }}
                onDelete={() => {
                  setDeleteError(null);
                  setPendingDelete(rule);
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除策略 ${pendingDelete?.matchKind === "pattern" ? pendingDelete.matchValue.slice(0, 30) : "此规则"}？`}
        description="删除后对应命令形态回到默认审批卡行为；内置黑名单删除后重启不会复活。"
        confirmText="删除"
        destructive
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void remove()}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </DialogShell>
  );
}

function PolicyRow(props: {
  rule: HostExecPolicyDTO;
  wildcard?: boolean;
  agentName?: string;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { rule } = props;
  const summary =
    rule.matchKind === "prefix"
      ? rule.matchValue.split(/\r?\n/).slice(0, 3).join(" / ") +
        (rule.matchValue.split(/\r?\n/).length > 3 ? " …" : "")
      : rule.matchValue;
  const decisionTone = rule.decision === "deny" ? "danger" : rule.decision === "allow" ? "success" : "warning";
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2">
      <Switch
        checked={rule.enabled}
        aria-label={`启停策略 ${rule.id}`}
        onCheckedChange={props.onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={decisionTone}>{rule.decision.toUpperCase()}</Badge>
          <span className="text-xs text-muted-foreground">
            {rule.tool === "*" ? "两工具" : rule.tool}
            {" · "}
            {props.wildcard ? "全部主机" : "本主机"}
            {" · "}
            {rule.scopeKind === "agent" ? `agent=${props.agentName ?? rule.scopeRef}` : rule.scopeKind}
            {" · "}
            {rule.unattended === "allow" ? "无人值守放行" : "无人值守跟随"}
          </span>
          {!rule.enabled ? <Badge tone="warning">已停用</Badge> : null}
        </div>
        <div className="mt-1 truncate font-mono text-[12px] text-slate-600" title={summary}>
          {summary}
        </div>
        {rule.note ? (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={rule.note}>
            {rule.note}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" onClick={props.onEdit}>
          编辑
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={props.onDelete}>
          删除
        </Button>
      </div>
    </div>
  );
}
