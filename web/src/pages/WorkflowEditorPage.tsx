import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/page-header";
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/triggers")
      .then((r) => r.json() as Promise<{ triggers?: Trigger[] }>)
      .then((d) => setTriggers(d.triggers ?? []))
      .catch(() => setTriggers([]));
    fetchAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!id) return;
    apiFetch(`/api/workflows/${id}`)
      .then((r) => r.json() as Promise<WorkflowDTO>)
      .then((w) => {
        setName(w.name);
        setDescription(w.description ?? "");
        setTriggerId(w.triggerId);
        setAgentId(w.agentId);
        if (w.promptTemplate) setPromptTemplate(w.promptTemplate);
        if (w.outputSubdir) setOutputSubdir(w.outputSubdir);
      })
      .catch(() => {});
  }, [id]);

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

  return (
    <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
      <PageHeader className="mb-4" title={id ? "编辑工作流" : "新建工作流"} />
      <label className="mb-2 block">
        名称
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
      </label>
      <label className="mb-2 block">
        描述
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
      </label>
      <label className="mb-2 block">
        Trigger
        <select
          value={triggerId}
          onChange={(e) => setTriggerId(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        >
          <option value="">— 选择 —</option>
          {triggers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.type}）
            </option>
          ))}
        </select>
      </label>
      <label className="mb-2 block">
        Agent
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        >
          <option value="">— 选择 —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {!a._mine ? "（共享）" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="mb-2 block">
        Prompt 模板
        <textarea
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          rows={4}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none font-mono text-sm"
        />
      </label>
      <small className="text-muted-foreground">
        <code>{`{{triggerOutput}}`}</code> 会被替换为 trigger 抓取的内容
      </small>
      <label className="mt-2 mb-2 block">
        输出子目录
        <input
          value={outputSubdir}
          onChange={(e) => setOutputSubdir(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
      </label>
      {error ? (
        <div className="mb-3 rounded bg-destructive-soft p-2 text-sm text-destructive">{error}</div>
      ) : null}
      <Button type="button" onClick={save} disabled={saving}>
        保存
      </Button>
    </div>
  );
}
