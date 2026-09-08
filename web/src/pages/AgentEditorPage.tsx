import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  filterSkillSelectorOptions,
  getDefaultSkillOptions,
  mergeSkillSelectorOptions,
  type SkillSelectorOption,
} from "../lib/skillSelector";
import { fetchCredentialTemplates, fetchMyCredentials } from "../lib/skills";

const empty: Omit<AgentDTO, "id" | "ownerId" | "createdAt" | "updatedAt"> = {
  name: "",
  description: "",
  systemPrompt: "",
  skills: [],
  defaultSkill: undefined,
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  credentials: [],
  gitRepositories: [],
  extensionDirectories: [],
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
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    fetchAgentMeta()
      .then(setMeta)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isNew && id) {
      setReadOnly(false);
      fetchAgent(id)
        .then((a) => {
          const editable = a.editable !== false && Array.isArray(a.skills);
          if (!editable) {
            setReadOnly(true);
            setForm({ ...empty, name: a.name, description: a.description ?? "" });
            return;
          }
          setForm({
            name: a.name,
            description: a.description ?? "",
            systemPrompt: a.systemPrompt ?? "",
            skills: a.skills,
            defaultSkill: a.defaultSkill,
            tools: a.tools,
            mcpServers: a.mcpServers,
            credentials: a.credentials ?? [],
            gitRepositories: a.gitRepositories ?? [],
            extensionDirectories: a.extensionDirectories ?? [],
            llm: a.llm,
          });
        })
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

  if (readOnly && !isNew && id) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">{form.name}</h1>
            <Link
              to={`/agents/${id}/chat`}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            >
              对话
            </Link>
          </div>
          {form.description ? (
            <p className="text-sm text-muted-foreground">{form.description}</p>
          ) : null}
          <p className="rounded border bg-muted/40 p-3 text-sm text-muted-foreground">
            这是共享智能体。你可以使用它进行对话，但无权查看或编辑创建者的详细配置。
          </p>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => navigate("/agents")}
          >
            返回智能体管理
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
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

        <Field label="Skills（可多选，支持模糊搜索）">
          <SkillPicker
            options={meta.skills}
            value={form.skills}
            onChange={(skills) =>
              setForm({
                ...form,
                skills,
                defaultSkill:
                  skills.length > 0 && form.defaultSkill && !skills.includes(form.defaultSkill)
                    ? undefined
                    : form.defaultSkill,
              })
            }
          />
        </Field>

        <CredentialPicker
          value={form.credentials ?? []}
          onChange={(credentials) => setForm({ ...form, credentials })}
        />

        <Field label="默认 Skill（可选）">
          <select
            className="w-full rounded border px-2 py-1"
            value={form.defaultSkill ?? ""}
            onChange={(event) =>
              setForm({ ...form, defaultSkill: event.target.value || undefined })
            }
          >
            <option value="">不设置</option>
            {getDefaultSkillOptions(meta.skills, form.skills).map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.name || skill.id}
                {skill.name && skill.name !== skill.id ? `（${skill.id}）` : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            对话时会在每次用户输入后自动追加 /{`{默认 Skill}`}，触发对应技能。
          </p>
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
                            itemIndex === index
                              ? { ...item, required: event.target.checked }
                              : item,
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

        <Field label="扩展工作目录">
          <div className="space-y-2">
            {form.extensionDirectories.map((directory, index) => (
              <div key={directory.id} className="grid gap-2 rounded border p-3 sm:grid-cols-6">
                <input
                  className="rounded border px-2 py-1 text-sm sm:col-span-2"
                  placeholder="显示名称"
                  value={directory.name}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      extensionDirectories: form.extensionDirectories.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.target.value } : item,
                      ),
                    })
                  }
                />
                <input
                  className="rounded border px-2 py-1 text-sm sm:col-span-3"
                  placeholder="宿主机绝对目录"
                  value={directory.path}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      extensionDirectories: form.extensionDirectories.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, path: event.target.value } : item,
                      ),
                    })
                  }
                />
                <select
                  className="rounded border px-2 py-1 text-sm"
                  value={directory.access}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      extensionDirectories: form.extensionDirectories.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              access: event.target.value as "readOnly" | "readWrite",
                            }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="readWrite">读写</option>
                  <option value="readOnly">只读</option>
                </select>
                <button
                  type="button"
                  className="text-left text-xs text-destructive sm:col-span-6"
                  onClick={() =>
                    setForm({
                      ...form,
                      extensionDirectories: form.extensionDirectories.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  删除目录
                </button>
              </div>
            ))}
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm"
              onClick={() =>
                setForm({
                  ...form,
                  extensionDirectories: [
                    ...form.extensionDirectories,
                    { id: crypto.randomUUID(), name: "", path: "", access: "readWrite" },
                  ],
                })
              }
            >
              添加工作目录
            </button>
            <p className="text-xs text-muted-foreground">
              目录仅在智能体创建者自己的会话中生效；共享用户不会获得宿主目录权限。
            </p>
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

function SkillPicker({
  options,
  value,
  onChange,
}: {
  options: SkillSelectorOption[];
  value: string[];
  onChange: (skills: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const allOptions = useMemo(() => mergeSkillSelectorOptions(options, value), [options, value]);
  const filteredOptions = useMemo(
    () => filterSkillSelectorOptions(allOptions, query),
    [allOptions, query],
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="flex min-h-9 w-full items-center justify-between rounded border px-2 py-1 text-left text-sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={value.length ? "truncate" : "text-muted-foreground"}>
          {value.length ? `已选择 ${value.length} 个技能` : "请选择技能"}
        </span>
        <span className="ml-2 text-muted-foreground">{open ? "▴" : "▾"}</span>
      </button>
      {value.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {value.map((id) => (
            <button
              key={id}
              type="button"
              className="rounded bg-accent px-2 py-0.5 text-xs hover:bg-accent/80"
              onClick={() => toggle(id)}
              title="点击移除"
            >
              {id} ×
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="absolute z-30 mt-1 w-full rounded border bg-background p-2 shadow-lg">
          <input
            className="mb-2 w-full rounded border px-2 py-1 text-sm"
            placeholder="搜索技能名称、ID或描述"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {filteredOptions.length ? (
              filteredOptions.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={value.includes(option.id)}
                    onChange={() => toggle(option.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{option.name || option.id}</span>
                    {option.description ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {option.id} · {option.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))
            ) : (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {allOptions.length ? "没有匹配的技能" : "暂无可选技能"}
              </p>
            )}
          </div>
        </div>
      ) : null}
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

/** 凭证勾选：选项 = 我的凭证 ∪ 全局模板；运行时按当前用户已配置的值注入 */
function CredentialPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
}) {
  const [options, setOptions] = useState<
    Array<{ code: string; name: string; keys: string[]; configured: boolean }>
  >([]);

  useEffect(() => {
    void (async () => {
      try {
        const [mine, templates] = await Promise.all([
          fetchMyCredentials(),
          fetchCredentialTemplates(),
        ]);
        const mineCodes = new Set(mine.map((m) => m.code));
        const seen = new Set<string>();
        const options: Array<{
          code: string;
          name: string;
          keys: string[];
          configured: boolean;
        }> = [];
        for (const m of mine) {
          if (seen.has(m.code)) continue;
          seen.add(m.code);
          options.push({
            code: m.code,
            name: m.name,
            keys: m.keySpecs.map((k) => k.key),
            configured: true,
          });
        }
        for (const t of templates) {
          if (seen.has(t.code)) continue;
          seen.add(t.code);
          options.push({
            code: t.code,
            name: t.name,
            keys: t.keySpecs.map((k) => k.key),
            configured: false,
          });
        }
        setOptions(options);
        void mineCodes;
      } catch {
        // 凭证存储未装配或网络失败：不阻断 agent 编辑
      }
    })();
  }, []);

  const toggle = (code: string) =>
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);

  return (
    <Field label="凭证（勾选后运行时按当前用户已配置的值注入）">
      {options.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          暂无可选凭证。可先到「凭证管理」页创建。
        </div>
      ) : (
        <div className="space-y-1">
          {options.map((o) => (
            <label key={o.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value.includes(o.code)}
                onChange={() => toggle(o.code)}
              />
              <span className="font-mono">{o.code}</span>
              <span>{o.name}</span>
              <span className="text-xs text-muted-foreground">
                keys=[{o.keys.join(",")}]{o.configured ? " · 已配置" : " · 未配置（执行时会询问）"}
              </span>
            </label>
          ))}
        </div>
      )}
    </Field>
  );
}
