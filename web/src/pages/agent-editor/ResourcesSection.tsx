import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { type AgentConversationScopeDTO, fetchAgents } from "../../lib/agents";
import { fetchCredentialTemplates, fetchMyCredentials } from "../../lib/skills";
import { cn } from "../../lib/utils";
import type { AgentEditorForm } from "./model";
import { inferProviderFromUrl, inferRepoNameFromUrl, PROVIDER_LABELS } from "./model";

type GitRepo = AgentEditorForm["gitRepositories"][number];

export function ResourcesSection({
  form,
  patch,
  gitCredentialOptions,
}: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  /** git 用途凭证模板（kind=git）：仓库凭证下拉选项 */
  gitCredentialOptions: Array<{ code: string; name: string; repoUrl?: string }>;
}) {
  const patchRepo = (id: string, p: Partial<GitRepo>) => {
    patch({ gitRepositories: form.gitRepositories.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  };
  const removeRepo = (id: string) => {
    patch({ gitRepositories: form.gitRepositories.filter((r) => r.id !== id) });
  };
  const addRepo = () => {
    patch({
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
    });
  };

  const patchDir = (id: string, p: Partial<AgentEditorForm["extensionDirectories"][number]>) => {
    patch({
      extensionDirectories: form.extensionDirectories.map((d) =>
        d.id === id ? { ...d, ...p } : d,
      ),
    });
  };

  return (
    <FormSection
      id="agent-sec-resources"
      no="4"
      title="资源"
      description="凭证、Git 仓库与扩展工作目录"
    >
      <CredentialPicker
        value={form.credentials ?? []}
        onChange={(credentials) => patch({ credentials })}
        lockedCodes={[
          ...new Set(
            form.gitRepositories
              .map((r) => r.credentialCode)
              .filter((c): c is string => Boolean(c)),
          ),
        ]}
      />

      <ConversationScopePicker
        value={form.conversationScope ?? { enabled: false, agentIds: [] }}
        onChange={(conversationScope) => patch({ conversationScope })}
      />

      <FormField
        label={`Git 仓库（${form.gitRepositories.length} 个）`}
        hint="输入 URL 自动识别平台并预填目录名；分支/浅克隆等高级项默认折叠"
      >
        <div className="flex flex-col gap-2.5">
          {form.gitRepositories.map((repo) => (
            <GitRepoCard
              key={repo.id}
              repo={repo}
              gitCredentialOptions={gitCredentialOptions}
              onPatch={(p) => patchRepo(repo.id, p)}
              onRemove={() => removeRepo(repo.id)}
            />
          ))}
          <div>
            <Button variant="ghost" size="sm" onClick={addRepo}>
              <Plus size={14} aria-hidden="true" />
              添加仓库
            </Button>
          </div>
        </div>
      </FormField>

      <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive-soft/60 px-3.5 py-2.5">
        <Switch
          checked={form.gitAllowShellGit ?? false}
          onCheckedChange={(v) => patch({ gitAllowShellGit: v })}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-semibold">允许 shell git（默认关闭）</span>
          <span className="text-[11px] leading-snug text-muted-foreground">
            开启后 agent 可绕过 donger-git 工具直跑 git 命令；git push
            仍会弹审批卡。除非明确需要，请保持关闭。
          </span>
        </div>
      </div>

      <FormField
        label={`扩展工作目录（${form.extensionDirectories.length} 个）`}
        hint="仅在智能体创建者自己的会话中生效；共享用户不会获得宿主目录权限"
      >
        <div className="flex flex-col gap-2">
          {form.extensionDirectories.map((dir) => (
            <div
              key={dir.id}
              className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3 sm:flex-row"
            >
              <Input
                className="sm:w-44"
                placeholder="显示名称"
                value={dir.name}
                onChange={(e) => patchDir(dir.id, { name: e.target.value })}
              />
              <Input
                mono
                className="flex-1"
                placeholder="宿主机绝对目录"
                value={dir.path}
                onChange={(e) => patchDir(dir.id, { path: e.target.value })}
              />
              <Select
                className="sm:w-28"
                value={dir.access}
                onChange={(e) => patchDir(dir.id, { access: e.target.value as typeof dir.access })}
              >
                <option value="readWrite">读写</option>
                <option value="readOnly">只读</option>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 self-end text-muted-foreground hover:text-destructive sm:self-auto"
                title="删除目录"
                onClick={() =>
                  patch({
                    extensionDirectories: form.extensionDirectories.filter((d) => d.id !== dir.id),
                  })
                }
              >
                <X size={15} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                patch({
                  extensionDirectories: [
                    ...form.extensionDirectories,
                    { id: crypto.randomUUID(), name: "", path: "", access: "readWrite" },
                  ],
                })
              }
            >
              <Plus size={14} aria-hidden="true" />
              添加工作目录
            </Button>
          </div>
        </div>
      </FormField>
    </FormSection>
  );
}

/** 单个 Git 仓库卡：收起态只露 URL 主行；展开后编辑目录名/分支/凭证与高级项 */
function GitRepoCard({
  repo,
  gitCredentialOptions,
  onPatch,
  onRemove,
}: {
  repo: GitRepo;
  gitCredentialOptions: Array<{ code: string; name: string; repoUrl?: string }>;
  onPatch: (p: Partial<GitRepo>) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  const onUrlChange = (url: string) => {
    const detected = inferProviderFromUrl(url);
    setMismatch(Boolean(detected && detected !== repo.provider));
    onPatch({
      url,
      provider: detected ?? repo.provider,
      // 目录名未填时从 URL 尾段预填，避免留空保存被拒
      name: repo.name || inferRepoNameFromUrl(url),
    });
  };

  const onProviderChange = (provider: GitRepo["provider"]) => {
    const detected = inferProviderFromUrl(repo.url);
    setMismatch(Boolean(detected && detected !== provider));
    onPatch({ provider });
  };

  const selfHostedNote = (() => {
    try {
      const u = new URL(repo.url);
      if (
        u.protocol === "https:" &&
        !["github.com", "gitee.com", "jihulab.com"].includes(u.hostname.toLowerCase())
      ) {
        return (
          <p className="text-[11px] text-muted-foreground">
            自建/私有化地址：将按所选协议方言访问（{u.hostname}）
          </p>
        );
      }
    } catch {
      // 未输入完整 URL
    }
    return null;
  })();

  return (
    <div
      className={cn(
        "rounded-[10px] border bg-card transition-colors",
        expanded ? "border-primary" : "border-border",
      )}
    >
      {/* 主行：平台徽标 + URL + 目录名摘要 + 展开箭头 */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <Badge>
          {repo.provider === "github"
            ? "GitHub"
            : repo.provider === "gitee"
              ? "Gitee"
              : "GitLab 兼容"}
        </Badge>
        <input
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 font-mono text-xs focus:border-primary focus:outline-none"
          placeholder="https://github.com|gitee.com|jihulab.com|自建host/org/repo.git（仅 HTTPS）"
          value={repo.url}
          onChange={(e) => onUrlChange(e.target.value)}
        />
        {!expanded && repo.name ? (
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
            → {repo.name}/
          </span>
        ) : null}
        {!expanded && repo.required ? <Badge>必需</Badge> : null}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "收起" : "展开高级项"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDown
            size={15}
            className={cn("transition-transform", expanded && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="删除仓库"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {mismatch ? (
        <p className="px-3.5 pb-2 text-[11px] text-destructive">
          地址域名与所选协议方言不匹配（github.com / gitee.com / jihulab.com 会自动识别方言）
        </p>
      ) : null}
      {expanded ? (
        <div className="flex flex-col gap-2.5 border-t border-border p-3.5">
          <div className="grid gap-2.5 sm:grid-cols-3">
            <Select
              value={repo.provider}
              onChange={(e) => onProviderChange(e.target.value as GitRepo["provider"])}
            >
              {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Input
              placeholder="目录名，如 backend"
              value={repo.name}
              onChange={(e) => onPatch({ name: e.target.value })}
            />
            <Input
              placeholder="分支/tag，默认仓库默认分支"
              value={repo.ref ?? ""}
              onChange={(e) => onPatch({ ref: e.target.value || undefined })}
            />
          </div>
          {selfHostedNote}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Select
              value={repo.credentialCode ?? ""}
              onChange={(e) => onPatch({ credentialCode: e.target.value || undefined })}
            >
              <option value="">凭证模板（私有仓库必选，git PAT 类）</option>
              {gitCredentialOptions.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.code}（{t.name}
                  {t.repoUrl ? ` · ${t.repoUrl}` : " · 平台级"}）
                </option>
              ))}
            </Select>
            <Input
              placeholder="浅克隆历史窗口（如 1 year ago，仅浅克隆生效）"
              value={repo.shallowSince ?? ""}
              onChange={(e) => onPatch({ shallowSince: e.target.value || undefined })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-muted/50 px-3 py-2">
            <Checkbox
              checked={repo.required}
              onChange={(e) => onPatch({ required: e.target.checked })}
              label={<span className="text-xs text-muted-foreground">必需仓库</span>}
            />
            <Checkbox
              checked={repo.shallow}
              onChange={(e) => onPatch({ shallow: e.target.checked })}
              label={<span className="text-xs text-muted-foreground">浅克隆</span>}
            />
            <Select
              className="w-36"
              value={repo.syncMode}
              onChange={(e) => onPatch({ syncMode: e.target.value as GitRepo["syncMode"] })}
            >
              <option value="fastForward">安全同步</option>
              <option value="cloneOnce">仅首次克隆</option>
            </Select>
          </div>
        </div>
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
  /** 被 git 仓库绑定 credentialCode 引用的模板：后端强制并入，UI 锁定并标注来源 */
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
        const merged: Array<{ code: string; name: string; keys: string[]; configured: boolean }> =
          [];
        for (const m of mine) {
          if (seen.has(m.code)) continue;
          seen.add(m.code);
          merged.push({
            code: m.code,
            name: m.name,
            keys: m.keySpecs.map((k) => k.key),
            configured: true,
          });
        }
        for (const t of templates) {
          if (seen.has(t.code)) continue;
          seen.add(t.code);
          merged.push({
            code: t.code,
            name: t.name,
            keys: t.keySpecs.map((k) => k.key),
            configured: false,
          });
        }
        setOptions(merged);
      } catch {
        // 加载失败显式呈现（可重试），不静默显示"暂无"
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
    <FormField label="凭证" hint="勾选后运行时按当前用户已配置的值注入；未配置的执行时会询问">
      {loadError ? (
        <button
          type="button"
          className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive-soft"
          onClick={() => setReloadTick((t) => t + 1)}
        >
          凭证列表加载失败，点击重试
        </button>
      ) : options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          暂无可选凭证。可先到
          <Link to="/credentials" className="mx-0.5 text-primary hover:underline">
            凭证管理
          </Link>
          页创建。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {options.map((o) => {
            const locked = lockedCodes.includes(o.code);
            const checked = locked || value.includes(o.code);
            return (
              <div
                key={o.code}
                className={cn(
                  "flex items-center gap-2.5 rounded-[10px] border px-3 py-2",
                  checked ? "border-primary/40 bg-primary-soft/40" : "border-border bg-card",
                  locked && "opacity-80",
                )}
              >
                {locked ? (
                  <Badge>锁定</Badge>
                ) : (
                  <Checkbox checked={checked} onChange={() => toggle(o.code)} />
                )}
                <span className="shrink-0 font-mono text-xs font-medium">{o.code}</span>
                <span
                  className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                  title={o.name}
                >
                  {o.name}
                </span>
                <Badge tone={locked ? "neutral" : o.configured ? "success" : "warning"}>
                  {locked ? "仓库绑定" : o.configured ? "已配置" : "未配置"}
                </Badge>
                {!locked && !o.configured ? (
                  <Link
                    to="/credentials"
                    className="shrink-0 text-[11px] font-semibold text-primary hover:underline"
                  >
                    去配置 →
                  </Link>
                ) : null}
                <span
                  className="shrink-0 cursor-help text-[10px] text-muted-foreground/70"
                  title={
                    locked
                      ? "由 git 仓库绑定的凭证引用强制勾选；如需移除请在其绑定的仓库中改选"
                      : `keys=[${o.keys.join(",")}]`
                  }
                >
                  keys
                </span>
              </div>
            );
          })}
        </div>
      )}
    </FormField>
  );
}

/** 输入的窗口数字归一：空串=不限（undefined），非法/越界收敛到 1-99 */
function toScopeInt(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(n, 99);
}

/**
 * 会话资源范围（% 会话引用）：启用开关（默认关）+ 智能体多选（空=仅本智能体）+ 时间窗口。
 * 关闭时配置项置灰但仍展示，暗示开启后可配。
 */
function ConversationScopePicker({
  value,
  onChange,
}: {
  value: AgentConversationScopeDTO;
  onChange: (scope: AgentConversationScopeDTO) => void;
}) {
  const [options, setOptions] = useState<Array<{ id: string; name: string; mine: boolean }>>([]);
  const [loadError, setLoadError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 仅用于手动重试时触发重新加载
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchAgents();
        if (cancelled) return;
        setLoadError(false);
        setOptions(list.map((a) => ({ id: a.id, name: a.name, mine: a._mine })));
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const toggleAgent = (id: string) => {
    const next = value.agentIds.includes(id)
      ? value.agentIds.filter((a) => a !== id)
      : [...value.agentIds, id];
    onChange({ ...value, agentIds: next });
  };

  return (
    <FormField
      label="会话"
      hint="开启后可在对话中用 % 引用历史会话内容；引用范围与「全部会话」都受以下配置限制"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2">
          <Switch
            checked={value.enabled}
            onCheckedChange={(v) => onChange({ ...value, enabled: v })}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-semibold">启用会话引用</span>
            <span className="text-[11px] leading-snug text-muted-foreground">
              默认关闭；开启后对话输入框可用 % 引用历史会话
            </span>
          </div>
        </div>

        <div
          className={cn(
            "flex flex-col gap-2.5",
            !value.enabled && "pointer-events-none opacity-50",
          )}
          aria-disabled={!value.enabled}
        >
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              智能体范围（不勾选 = 仅引用绑定本智能体的会话）
            </span>
            {loadError ? (
              <button
                type="button"
                className="w-fit rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive-soft"
                onClick={() => setReloadTick((t) => t + 1)}
              >
                智能体列表加载失败，点击重试
              </button>
            ) : options.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无可选智能体</p>
            ) : (
              <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto rounded-[10px] border border-border bg-card p-2">
                {options.map((o) => {
                  const checked = value.agentIds.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggleAgent(o.id)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none",
                        checked ? "bg-primary-soft/40" : "hover:bg-muted",
                      )}
                    >
                      <Checkbox checked={checked} onChange={() => toggleAgent(o.id)} />
                      <span className="min-w-0 flex-1 truncate">{o.name}</span>
                      <Badge tone={o.mine ? "neutral" : "success"}>
                        {o.mine ? "我的" : "共享"}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">最近天数（1-99，留空不限）</span>
              <Input
                type="number"
                min={1}
                max={99}
                aria-label="引用会话的最近天数"
                placeholder="如 7"
                value={value.days ?? ""}
                onChange={(e) => onChange({ ...value, days: toScopeInt(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">最近条数（1-99，留空默认 10）</span>
              <Input
                type="number"
                min={1}
                max={99}
                aria-label="引用会话的最近条数"
                placeholder="如 20"
                value={value.limit ?? ""}
                onChange={(e) => onChange({ ...value, limit: toScopeInt(e.target.value) })}
              />
            </div>
          </div>
        </div>
      </div>
    </FormField>
  );
}
