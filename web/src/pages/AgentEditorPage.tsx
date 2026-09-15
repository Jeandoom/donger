import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/ui/page-header";
import {
  type AgentDTO,
  type AgentMeta,
  createAgent,
  fetchAgent,
  fetchAgentMeta,
  updateAgent,
} from "../lib/agents";
import { type ConnectorDTO, fetchConnectors } from "../lib/connectors";
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
import type { AgentPermissionMode } from "../types";

const empty: Omit<AgentDTO, "id" | "ownerId" | "createdAt" | "updatedAt"> = {
  name: "",
  description: "",
  systemPrompt: "",
  skills: [],
  defaultSkill: undefined,
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  connectorIds: [],
  credentials: [],
  gitRepositories: [],
  extensionDirectories: [],
  scenario: undefined,
  gitAllowShellGit: false,
  defaultPermissionMode: "ask_before_change",
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
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [warnings, setWarnings] = useState<string[]>();
  const [readOnly, setReadOnly] = useState(false);
  const [hostMismatch, setHostMismatch] = useState<Record<number, boolean>>({});
  const [gitCredentialOptions, setGitCredentialOptions] = useState<
    Array<{ code: string; name: string; repoUrl?: string }>
  >([]);
  const [connectors, setConnectors] = useState<ConnectorDTO[]>([]);

  useEffect(() => {
    fetchAgentMeta()
      .then(setMeta)
      .catch(() => {});
  }, []);

  // git 用途凭证模板（kind=git）：仓库凭证下拉选项；值不注入 env，仅工具现取
  useEffect(() => {
    fetchCredentialTemplates()
      .then((templates) =>
        setGitCredentialOptions(
          templates
            .filter((t) => t.kind === "git")
            .map((t) => ({ code: t.code, name: t.name, repoUrl: t.repoUrl })),
        ),
      )
      .catch(() => {});
  }, []);

  // 连接器列表：MCP 工具区域的勾选项
  useEffect(() => {
    fetchConnectors()
      .then(setConnectors)
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
            connectorIds: a.connectorIds ?? [],
            credentials: a.credentials ?? [],
            gitRepositories: a.gitRepositories ?? [],
            extensionDirectories: a.extensionDirectories ?? [],
            scenario: a.scenario,
            gitAllowShellGit: a.gitAllowShellGit ?? false,
            defaultPermissionMode: a.defaultPermissionMode ?? "ask_before_change",
            llm: a.llm,
          });
        })
        .catch(() => navigate("/agents"));
    }
  }, [id, isNew, navigate]);

  async function save() {
    setError(undefined);
    if (!form.name.trim()) {
      setError("请填写名称");
      nameInputRef.current?.focus();
      nameInputRef.current?.scrollIntoView({ block: "center" });
      return;
    }
    // 与后端 AgentGitRepositorySchema 同源校验：非法目录名一旦落库，读路径会让整个 agent 列表 500
    for (const r of form.gitRepositories) {
      if (!REPO_NAME_PATTERN.test(r.name)) {
        setError(
          `仓库目录名「${r.name || "（空）"}」不合法：需以字母/数字开头，仅含字母数字 . _ -，长度 1-64`,
        );
        return;
      }
    }
    setSaving(true);
    setWarnings(undefined);
    try {
      const saved = isNew ? await createAgent(form) : await updateAgent(id ?? "", form);
      if (saved.warnings && saved.warnings.length > 0) {
        // 装备告警不阻断：留在编辑页展示（场景校验/凭证缺值提示）
        setWarnings(saved.warnings);
        setSaving(false);
        return;
      }
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
          <PageHeader
            title={form.name}
            actions={
              <Link
                to={`/agents/${id}/chat`}
                className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
              >
                对话
              </Link>
            }
          />
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
        <PageHeader
          title={isNew ? "新建智能体" : "编辑智能体"}
          description={isNew ? undefined : form.name}
          actions={
            !isNew && id ? (
              <Link
                to={`/agents/${id}/chat`}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
              >
                对话
              </Link>
            ) : undefined
          }
        />

        {error ? <p className="text-destructive">{error}</p> : null}
        {warnings && warnings.length > 0 ? (
          <div className="space-y-1 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">装备提示（已保存，可稍后处理）</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Field label="名称（必填）">
          <input
            ref={nameInputRef}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>

        <Field label="描述">
          <input
            className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none"
            value={form.description ?? ""}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>

        <Field label="System Prompt（追加到默认之后）">
          <textarea
            className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none"
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
          lockedCodes={[
            ...new Set(
              form.gitRepositories
                .map((r) => r.credentialCode)
                .filter((c): c is string => Boolean(c)),
            ),
          ]}
        />

        <Field label="场景">
          <select
            className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none"
            value={form.scenario ?? ""}
            onChange={(event) =>
              setForm({
                ...form,
                scenario: (event.target.value || undefined) as typeof form.scenario,
              })
            }
          >
            <option value="">不设置</option>
            <option value="code-dev">code-dev（代码项目开发运维）</option>
            <option value="kb-qa">kb-qa（知识库问答，只读）</option>
            <option value="research">research（调研分析，可写知识库）</option>
            <option value="ops">ops（运维操作）</option>
          </select>
          <p className="text-xs text-muted-foreground">
            场景决定装配校验：code-dev 需绑定 git 仓库；kb-qa 要求只读白名单；research 需含
            kb_write。
          </p>
        </Field>

        <Field label="默认 Skill（可选）">
          <select
            className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none"
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

        <Field label="默认对话模式">
          <select
            className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none"
            value={form.defaultPermissionMode ?? "ask_before_change"}
            onChange={(event) =>
              setForm({
                ...form,
                defaultPermissionMode: event.target.value as AgentPermissionMode,
              })
            }
          >
            <option value="ask_before_change">变更前问询（默认）</option>
            <option value="full_access">完全权限（跳过审批卡，高危操作直接执行）</option>
          </select>
          <p className="text-xs text-muted-foreground">
            会话默认按此模式校验工具调用，用户可在聊天头部临时切换（完全权限下 deploy/push
            等高危操作不再弹审批卡；白名单与文件写入边界不受影响；无人值守任务恒按变更前问询）。
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
            className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none"
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

        <Field label="MCP 工具">
          <div className="space-y-3 rounded border p-3">
            {/* 内置：随配置自动挂载，只读标注（spec 2026-09-11-connectors §7.2） */}
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                内置（随配置自动挂载，不可编辑）
              </div>
              <div className="space-y-0.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>🔒 donger-kb</span>
                  <span className="text-muted-foreground">知识库读写检索 · 恒挂载</span>
                </div>
                <div className="flex items-center gap-2">
                  <span>🔒 donger-git</span>
                  <span className="text-muted-foreground">Git 工作区/平台 · 绑定仓库后挂载</span>
                </div>
                <div className="flex items-center gap-2">
                  <span>🔒 donger-platform</span>
                  <span className="text-muted-foreground">平台元工具 · 仅内置智能体</span>
                </div>
              </div>
            </div>
            {/* 连接器勾选：连接器模块注册的 HTTP MCP */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">连接器（勾选启用）</span>
                <Link to="/connectors" className="text-xs text-primary hover:underline">
                  管理连接器 →
                </Link>
              </div>
              {connectors.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  暂无可用连接器，可到「连接器」页创建。
                </div>
              ) : (
                <div className="space-y-0.5">
                  {connectors.map((c) => {
                    const checked = (form.connectorIds ?? []).includes(c.id);
                    let host = c.url;
                    try {
                      host = new URL(c.url).host;
                    } catch {
                      // 非法 URL 原样展示
                    }
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-2 text-sm ${c.enabled ? "" : "opacity-50"}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              connectorIds: e.target.checked
                                ? [...(form.connectorIds ?? []), c.id]
                                : (form.connectorIds ?? []).filter((x) => x !== c.id),
                            })
                          }
                        />
                        <span className="font-mono">{c.name}</span>
                        <span className="text-xs text-muted-foreground">{host}</span>
                        {c.shareScope === "global" && (
                          <span className="rounded bg-emerald-500/10 px-1 text-xs text-emerald-600">
                            全局
                          </span>
                        )}
                        {!c.enabled && (
                          <span className="text-xs font-medium text-amber-600">
                            已停用（运行时跳过）
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            {/* 高级：内联 mcpServers JSON（与连接器重名会被后端硬拦） */}
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                高级：内联 MCP Servers（JSON）
              </summary>
              <div className="mt-1 space-y-1">
                <textarea
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none font-mono text-xs"
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
                  与连接器重名时保存会被拒绝（LLM 工具命名空间不可重名）。
                </p>
              </div>
            </details>
          </div>
        </Field>

        <Field label="Git 仓库">
          <div className="space-y-3">
            {form.gitRepositories.map((repository, index) => (
              <div key={repository.id} className="space-y-2 rounded border p-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <select
                    className="rounded border px-2 py-1 text-sm"
                    value={repository.provider}
                    onChange={(event) => {
                      const provider = event.target.value as typeof repository.provider;
                      const detected = inferProviderFromUrl(repository.url);
                      // 用户已输入的地址与新平台 host 不匹配时提示（不强制清空）
                      setForm({
                        ...form,
                        gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, provider } : item,
                        ),
                      });
                      setHostMismatch((m) => ({
                        ...m,
                        [index]: Boolean(detected && detected !== provider),
                      }));
                    }}
                  >
                    <option value="github">GitHub（含 GHE）</option>
                    <option value="gitee">Gitee（含私有化）</option>
                    <option value="jihulab">GitLab 兼容（极狐/自建）</option>
                  </select>
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
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none text-sm"
                  placeholder={`https://github.com|gitee.com|jihulab.com|自建host/org/repo.git（仅 HTTPS）`}
                  value={repository.url}
                  onChange={(event) => {
                    const url = event.target.value;
                    const detected = inferProviderFromUrl(url);
                    setForm({
                      ...form,
                      gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              url,
                              provider: detected ?? item.provider,
                              // 目录名未填时从 URL 尾段预填，避免留空保存被拒
                              name: item.name || inferRepoNameFromUrl(url),
                            }
                          : item,
                      ),
                    });
                    setHostMismatch((m) => ({
                      ...m,
                      [index]: Boolean(detected && detected !== repository.provider),
                    }));
                  }}
                />
                {hostMismatch[index] ? (
                  <p className="text-xs text-destructive">
                    地址域名与所选协议方言不匹配（github.com / gitee.com / jihulab.com
                    会自动识别方言）
                  </p>
                ) : null}
                {(() => {
                  try {
                    const u = new URL(repository.url);
                    if (
                      u.protocol === "https:" &&
                      !["github.com", "gitee.com", "jihulab.com"].includes(u.hostname.toLowerCase())
                    ) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          自建/私有化地址：将按上方所选协议方言访问（{u.hostname}）
                        </p>
                      );
                    }
                    return null;
                  } catch {
                    return null;
                  }
                })()}
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
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    className="rounded border px-2 py-1 text-sm"
                    value={repository.credentialCode ?? ""}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, credentialCode: event.target.value || undefined }
                            : item,
                        ),
                      })
                    }
                  >
                    <option value="">凭证模板（私有仓库必选，git PAT 类）</option>
                    {gitCredentialOptions.map((t) => (
                      <option key={t.code} value={t.code}>
                        {t.code}（{t.name}
                        {t.repoUrl ? ` · ${t.repoUrl}` : " · 平台级"}）
                      </option>
                    ))}
                  </select>
                  <input
                    className="rounded border px-2 py-1 text-sm"
                    placeholder="浅克隆历史窗口（如 1 year ago，仅浅克隆生效）"
                    value={repository.shallowSince ?? ""}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        gitRepositories: form.gitRepositories.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, shallowSince: event.target.value || undefined }
                            : item,
                        ),
                      })
                    }
                  />
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
            <label className="flex items-center gap-2 pt-1 text-sm">
              <input
                type="checkbox"
                checked={form.gitAllowShellGit ?? false}
                onChange={(event) => setForm({ ...form, gitAllowShellGit: event.target.checked })}
              />
              允许 shell git（默认关闭：git 操作只准走 donger-git 工具；开启后 agent 可绕过工具直跑
              git 命令，git push 仍会弹审批卡。除非明确需要，请保持关闭）
            </label>
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
              className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-muted/80"
              onClick={() => toggle(id)}
              title="点击移除"
            >
              {id} ×
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-card p-2 shadow-lg">
          <input
            className="mb-2 w-full rounded-lg border border-border bg-card px-3 py-2 focus:border-primary focus:outline-none text-sm"
            placeholder="搜索技能名称、ID或描述"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {filteredOptions.length ? (
              filteredOptions.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
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
  lockedCodes = [],
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  /** 被 git 仓库绑定 credentialCode 引用的模板：后端会强制并入 credentials，UI 锁定为勾选并标注来源 */
  lockedCodes?: string[];
}) {
  const [options, setOptions] = useState<
    Array<{ code: string; name: string; keys: string[]; configured: boolean }>
  >([]);
  const [loadError, setLoadError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 仅用于手动重试时触发重新加载
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [mine, templates] = await Promise.all([
          fetchMyCredentials(),
          fetchCredentialTemplates(),
        ]);
        if (cancelled) return;
        setLoadError(false);
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
      } catch {
        // 加载失败显式呈现（可重试），不再静默显示"暂无"
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const toggle = (code: string) => {
    if (lockedCodes.includes(code)) return;
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  };

  return (
    <Field label="凭证（勾选后运行时按当前用户已配置的值注入）">
      {loadError ? (
        <button
          type="button"
          className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
          onClick={() => setReloadTick((t) => t + 1)}
        >
          凭证列表加载失败，点击重试
        </button>
      ) : options.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          暂无可选凭证。可先到「凭证管理」页创建。
        </div>
      ) : (
        <div className="space-y-1">
          {options.map((o) => {
            const locked = lockedCodes.includes(o.code);
            const checked = locked || value.includes(o.code);
            return (
              <label key={o.code} className="flex items-center gap-2 overflow-hidden text-sm">
                <input
                  type="checkbox"
                  className="shrink-0"
                  checked={checked}
                  disabled={locked}
                  onChange={() => toggle(o.code)}
                />
                <span className="shrink-0 whitespace-nowrap font-mono">{o.code}</span>
                <span className="min-w-0 flex-1 truncate" title={o.name}>
                  {o.name}
                </span>
                <span
                  className="min-w-0 shrink truncate text-xs text-muted-foreground"
                  title={
                    locked
                      ? "由 git 仓库绑定的凭证引用强制勾选；如需移除请在下方「git 仓库」绑定的凭证下拉中改选"
                      : `keys=[${o.keys.join(",")}]${o.configured ? " · 已配置" : " · 未配置（执行时会询问）"}`
                  }
                >
                  {locked
                    ? "由仓库绑定引入（在下方 git 仓库绑定中修改）"
                    : `keys=[${o.keys.join(",")}]${o.configured ? " · 已配置" : " · 未配置（执行时会询问）"}`}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </Field>
  );
}

/** 仓库目录名约束（与后端 src/domain/git.ts AgentGitRepositorySchema 同源） */
const REPO_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** 从 URL 推断平台（host 精确匹配三平台；非 HTTPS/未知域名返回 undefined） */
function inferProviderFromUrl(url: string): "github" | "gitee" | "jihulab" | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.toLowerCase();
    if (host === "github.com") return "github";
    if (host === "gitee.com") return "gitee";
    if (host === "jihulab.com") return "jihulab";
    return undefined;
  } catch {
    return undefined;
  }
}

/** 从 URL 路径尾段推断默认目录名（非法字符转 -、掐掉头部符号；解析失败返回空串） */
function inferRepoNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean)
      .pop();
    return last?.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[._-]+/, "") ?? "";
  } catch {
    return "";
  }
}
