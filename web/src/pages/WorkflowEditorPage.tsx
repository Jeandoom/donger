import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { useDirtyGuard } from "../components/ui/dirty-guard";
import { FormField, FormSection } from "../components/ui/form-section";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { apiFetch } from "../lib/auth";

interface Trigger {
  id: string;
  name: string;
  type: "scheduler" | "hook";
}

interface WorkflowDTO {
  id: string;
  name: string;
  description?: string;
  triggerId: string;
  agentId: string;
  promptTemplate?: string;
  outputSubdir?: string;
}

export function WorkflowEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerId, setTriggerId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("{{triggerOutput}}");
  const [outputSubdir, setOutputSubdir] = useState("outputs/");
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [refsTick, setRefsTick] = useState(0);
  const [loading, setLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snapshot = JSON.stringify({
    name,
    description,
    triggerId,
    agentId,
    promptTemplate,
    outputSubdir,
  });
  const pristineRef = useRef<string | null>(null);
  useEffect(() => {
    if (loaded && pristineRef.current === null) pristineRef.current = snapshot;
  }, [loaded, snapshot]);
  const dirty = pristineRef.current !== null && snapshot !== pristineRef.current;
  const { attempt, dialog } = useDirtyGuard(dirty && !saving);

  // Trigger / Agent 下拉选项；失败显式可重试（原 .catch(() => []) 会把失败伪装成空列表）
  // biome-ignore lint/correctness/useExhaustiveDependencies: refsTick 仅用于手动重试时触发重新加载
  useEffect(() => {
    let cancelled = false;
    setRefsError(null);
    void (async () => {
      try {
        const [tr, ag] = await Promise.all([
          apiFetch("/api/triggers").then((r) => r.json() as Promise<{ triggers?: Trigger[] }>),
          fetchAgents(),
        ]);
        if (cancelled) return;
        setTriggers(tr.triggers ?? []);
        setAgents(ag);
      } catch (e) {
        if (!cancelled) setRefsError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refsTick]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await apiFetch(`/api/workflows/${id}`);
      if (!r.ok) throw new Error(`加载失败（HTTP ${r.status}）`);
      const w = (await r.json()) as WorkflowDTO;
      setName(w.name);
      setDescription(w.description ?? "");
      setTriggerId(w.triggerId);
      setAgentId(w.agentId);
      if (w.promptTemplate) setPromptTemplate(w.promptTemplate);
      if (w.outputSubdir) setOutputSubdir(w.outputSubdir);
      setLoaded(true);
      pristineRef.current = null; // 下一个 effect 以加载后的快照钉基线
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError("请填写名称");
      return;
    }
    if (!triggerId) {
      setError("请选择 Trigger");
      return;
    }
    if (!agentId) {
      setError("请选择 Agent");
      return;
    }
    setSaving(true);
    try {
      const url = id ? `/api/workflows/${id}` : "/api/workflows";
      const method = id ? "PUT" : "POST";
      const r = await apiFetch(url, {
        method,
        body: JSON.stringify({
          name,
          description: description || undefined,
          triggerId,
          agentId,
          promptTemplate,
          outputSubdir,
        }),
      });
      if (r.ok) {
        nav("/workflows");
        return;
      }
      let msg = await r.text();
      try {
        msg = (JSON.parse(msg) as { error?: string }).error ?? msg;
      } catch {
        // 非 JSON 响应保持原文
      }
      setError(`保存失败：${msg}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
        <div className="h-10 w-52 animate-pulse rounded bg-muted" />
        <div className="mt-5 space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
        <PageHeader className="mb-4" title={id ? "编辑工作流" : "新建工作流"} />
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
          <span>工作流加载失败：{loadError}</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" size={14} />
            重试
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        className="mb-5"
        title={id ? "编辑工作流" : "新建工作流"}
        description="触发器命中后驱动智能体执行一次任务"
        actions={
          <>
            <Button variant="secondary" onClick={() => attempt(() => nav("/workflows"))}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      />
      {error && (
        <div className="rounded-lg bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <FormSection id="wf-sec-basic" no="1" title="基础信息">
        <FormField label="名称" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 每日 issue 汇总"
          />
        </FormField>
        <FormField label="描述">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="工作流用途说明（可选）"
          />
        </FormField>
      </FormSection>

      <FormSection
        id="wf-sec-run"
        no="2"
        title="执行配置"
        description="触发来源、执行智能体与提示词模板"
      >
        {refsError ? (
          <button
            type="button"
            className="w-fit rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive-soft"
            onClick={() => setRefsTick((t) => t + 1)}
          >
            Trigger / Agent 列表加载失败，点击重试
          </button>
        ) : (
          <>
            <FormField label="Trigger" required>
              <Select value={triggerId} onChange={(e) => setTriggerId(e.target.value)}>
                <option value="">— 选择 —</option>
                {triggers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.type}）
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Agent" required>
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">— 选择 —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {!a._mine ? "（共享）" : ""}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        )}
        <FormField
          label="Prompt 模板"
          hint={
            <>
              <code>{`{{triggerOutput}}`}</code> 会被替换为 trigger 抓取的内容
            </>
          }
        >
          <Textarea
            mono
            rows={4}
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
          />
        </FormField>
        <FormField label="输出子目录">
          <Input mono value={outputSubdir} onChange={(e) => setOutputSubdir(e.target.value)} />
        </FormField>
      </FormSection>
      {dialog}
    </div>
  );
}
