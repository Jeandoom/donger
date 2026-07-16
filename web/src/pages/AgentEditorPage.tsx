import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type AgentDTO,
  type AgentMeta,
  createAgent,
  fetchAgent,
  fetchAgentMeta,
  updateAgent,
} from "../lib/agents";
import {
  fetchShareStatus,
  removeShareGrant,
  type ShareStatus,
  setShareEnabled,
} from "../lib/share";

const empty: Omit<AgentDTO, "id" | "ownerId" | "createdAt" | "updatedAt"> = {
  name: "",
  description: "",
  systemPrompt: "",
  skills: [],
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  gitRepositories: [],
  llm: {},
};

export function AgentEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const navigate = useNavigate();
  const [meta, setMeta] = useState<AgentMeta>({ skills: [], tools: [], llmPresets: [] });
  const [form, setForm] = useState<typeof empty>(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchAgentMeta()
      .then(setMeta)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isNew && id) {
      fetchAgent(id)
        .then((a) =>
          setForm({
            name: a.name,
            description: a.description ?? "",
            systemPrompt: a.systemPrompt ?? "",
            skills: a.skills,
            tools: a.tools,
            mcpServers: a.mcpServers,
            gitRepositories: a.gitRepositories ?? [],
            llm: a.llm,
          }),
        )
        .catch(() => navigate("/agents"));
    }
  }, [id, isNew, navigate]);

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const saved = isNew ? await createAgent(form) : await updateAgent(id ?? "", form);
      navigate(`/agents/${saved.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{isNew ? "新建智能体" : "编辑智能体"}</h1>
        {!isNew && id ? (
          <Link to={`/agents/${id}/chat`} className="rounded border px-3 py-1.5 text-sm">
            对话
          </Link>
        ) : null}
      </div>

      {error ? <p className="text-destructive">{error}</p> : null}

      <Field label="名称">
        <input
          className="w-full rounded border px-2 py-1"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </Field>

      <Field label="描述">
        <input
          className="w-full rounded border px-2 py-1"
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>

      <Field label="System Prompt（追加到默认之后）">
        <textarea
          className="w-full rounded border px-2 py-1"
          rows={4}
          value={form.systemPrompt ?? ""}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
      </Field>

      <Field label="Skills（每行一个，如 superpowers:brainstorming）">
        <textarea
          className="w-full rounded border px-2 py-1"
          rows={3}
          value={form.skills.join("\n")}
          onChange={(e) =>
            setForm({
              ...form,
              skills: e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
        {meta.skills.length ? (
          <p className="text-xs text-muted-foreground">
            可选：{meta.skills.map((s) => s.id).join("、")}
          </p>
        ) : null}
      </Field>

      <Field label="工具">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={form.tools.mode === "all"}
            onChange={() => setForm({ ...form, tools: { mode: "all", whitelist: [] } })}
          />
          全部工具
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={form.tools.mode === "whitelist"}
            onChange={() =>
              setForm({ ...form, tools: { mode: "whitelist", whitelist: form.tools.whitelist } })
            }
          />
          白名单
        </label>
        {form.tools.mode === "whitelist" ? (
          <div className="mt-1 flex flex-wrap gap-2">
            {meta.tools.map((t) => (
              <label key={t} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={form.tools.whitelist.includes(t)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      tools: {
                        mode: "whitelist",
                        whitelist: e.target.checked
                          ? [...form.tools.whitelist, t]
                          : form.tools.whitelist.filter((x) => x !== t),
                      },
                    })
                  }
                />
                {t}
              </label>
            ))}
          </div>
        ) : null}
      </Field>

      <Field label="LLM 预设">
        <select
          className="w-full rounded border px-2 py-1"
          value={form.llm.presetId ?? ""}
          onChange={(e) => setForm({ ...form, llm: { presetId: e.target.value || undefined } })}
        >
          <option value="">系统默认</option>
          {meta.llmPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.model}）
            </option>
          ))}
        </select>
      </Field>

      <Field label="MCP Servers（JSON）">
        <textarea
          className="w-full rounded border px-2 py-1 font-mono text-xs"
          rows={5}
          value={JSON.stringify(form.mcpServers, null, 2)}
          onChange={(e) => {
            try {
              setForm({ ...form, mcpServers: JSON.parse(e.target.value) });
            } catch {
              /* 编辑中，忽略解析错误 */
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          env/headers 中的密钥会加密入库；编辑时显示为掩码，留掩码即保留原值。
        </p>
      </Field>

      <Field label="Git 仓库">
        <div className="space-y-3">
          {form.gitRepositories.map((repository, index) => (
            <div key={repository.id} className="space-y-2 rounded border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  className="rounded border px-2 py-1 text-sm"
                  placeholder="目录名，如 backend"
                  value={repository.name}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.target.value } : item,
                      ),
                    })
                  }
                />
                <input
                  className="rounded border px-2 py-1 text-sm"
                  placeholder="分支/tag，默认仓库默认分支"
                  value={repository.ref ?? ""}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, ref: event.target.value || undefined }
                          : item,
                      ),
                    })
                  }
                />
              </div>
              <input
                className="w-full rounded border px-2 py-1 text-sm"
                placeholder="https://github.com/org/repo.git"
                value={repository.url}
                onChange={(event) => {
                  const url = event.target.value;
                  const provider = url.includes("gitee.com")
                    ? "gitee"
                    : url.includes("jihulab.com")
                      ? "jihulab"
                      : "github";
                  setForm({
                    ...form,
                    gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, url, provider } : item,
                    ),
                  });
                }}
              />
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <span>平台：{repository.provider}</span>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={repository.required}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, required: event.target.checked } : item,
                        ),
                      })
                    }
                  />
                  必需仓库
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={repository.shallow}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, shallow: event.target.checked } : item,
                        ),
                      })
                    }
                  />
                  浅克隆
                </label>
                <select
                  className="rounded border px-2 py-1"
                  value={repository.syncMode}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              syncMode: event.target.value as "cloneOnce" | "fastForward",
                            }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="fastForward">安全同步</option>
                  <option value="cloneOnce">仅首次克隆</option>
                </select>
                <button
                  type="button"
                  className="ml-auto text-destructive"
                  onClick={() =>
                    setForm({
                      ...form,
                      gitRepositories: form.gitRepositories.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  删除
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() =>
              setForm({
                ...form,
                gitRepositories: [
                  ...form.gitRepositories,
                  {
                    id: crypto.randomUUID(),
                    name: "",
                    provider: "github",
                    url: "",
                    required: true,
                    shallow: true,
                    syncMode: "fastForward",
                  },
                ],
              })
            }
          >
            添加仓库
          </button>
        </div>
      </Field>

      {!isNew && id ? <SharePanel agentId={id} /> : null}

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50"
          onClick={save}
          disabled={saving || !form.name}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="rounded border px-3 py-1.5"
          onClick={() => navigate("/agents")}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      {children}
    </div>
  );
}

function SharePanel({ agentId }: { agentId: string }) {
  const [status, setStatus] = useState<ShareStatus | null>(null);

  useEffect(() => {
    fetchShareStatus(agentId)
      .then(setStatus)
      .catch(() => {});
  }, [agentId]);

  if (!status) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const toggle = async () => {
    const next = await setShareEnabled(agentId, !status.enabled);
    setStatus({ ...status, ...next });
  };

  return (
    <div className="space-y-2 rounded border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">分享</span>
        <button type="button" className="rounded border px-2 py-1 text-sm" onClick={toggle}>
          {status.enabled ? "关闭分享" : "开启分享"}
        </button>
      </div>
      {status.enabled && status.url ? (
        <>
          <input
            readOnly
            className="w-full rounded border bg-muted px-2 py-1 text-xs"
            value={`${origin}${status.url}`}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <div className="text-xs text-muted-foreground">
            访问者名单（{status.grants.length}）：
          </div>
          <ul className="text-xs">
            {status.grants.map((g) => (
              <li key={g.userId} className="flex items-center justify-between">
                <span>{g.userId}</span>
                <button
                  type="button"
                  className="text-destructive"
                  onClick={async () => {
                    await removeShareGrant(agentId, g.userId);
                    setStatus({
                      ...status,
                      grants: status.grants.filter((x) => x.userId !== g.userId),
                    });
                  }}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
