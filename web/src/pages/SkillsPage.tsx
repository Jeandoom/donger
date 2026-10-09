import {
  ChevronDown,
  ChevronRight,
  Eye,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { DialogShell } from "../components/ui/dialog-shell";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Segmented } from "../components/ui/segmented";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { ASSIST_DRAFT_STORAGE_KEY, BUILTIN_ASSIST_AGENT_ID } from "../lib/assist";
import {
  cancelSkillJob,
  credentialStatus,
  fetchMyCredentials,
  fetchPacks,
  fetchPackUsage,
  fetchSkillDoc,
  fetchSkillInventory,
  fetchSkillRepo,
  hostSkill,
  installSkillToAgent,
  type PackUsageDTO,
  repoInstallSkill,
  type SkillInventoryDTO,
  type SkillInventoryRecordDTO,
  type SkillJobView,
  type SkillPackDTO,
  type SkillRepoConfigDTO,
  saveSkillRepo,
  setPackEnabled,
  setSkillEnabled,
  startSkillJob,
  syncSkillRepo,
  uninstallPack,
  verifySkillRepo,
  waitSkillJob,
} from "../lib/skills";
import { cn } from "../lib/utils";

/**
 * 安装/更新错误的结构化文案（2026-10 体验轮）：后端 SkillInstallError.code →
 * 人读首要原因；原始 message 保留在详情区可展开。未知 code 不猜，直接展示原文。
 */
const SKILL_ERROR_HINTS: Record<string, string> = {
  GIT_CLONE_FAILED: "仓库拉取失败：请检查地址与网络；私有仓库需选择已填令牌的 git 凭证。",
  GIT_PULL_FAILED: "拉取上游更新失败：请检查网络与凭证；上游若有强推需卸载后重装。",
  GIT_URL_INVALID: "git 地址须为不含凭证的 HTTPS 远程仓库地址。",
  GIT_SKILLS_NOT_FOUND: "仓库中未找到 SKILL.md：请确认仓库结构或「技能目录」路径是否正确。",
  GIT_SKILL_PATH_INVALID: "「技能目录」在仓库中不存在，请核对仓库内路径。",
  GIT_PACK_READ_ONLY: "git 来源的技能请在上游仓库修改后用「更新」同步。",
  CREDENTIAL_TOKEN_MISSING: "所选凭证尚未填写令牌：请先到「我的凭证」补全 access_token。",
  CREDENTIAL_REPO_MISMATCH: "该凭证绑定了另一个仓库（一凭一仓），请换用对应仓库的凭证。",
  CREDENTIAL_KIND_INVALID: "请选择 kind=git 的 PAT 凭证。",
  CREDENTIAL_NOT_FOUND: "所选凭证不存在，可能已被删除，请重新选择。",
  CREDENTIAL_UNAVAILABLE: "凭证系统未就绪，请联系管理员。",
  INVALID_SLUG: "slug 只能包含小写字母、数字和中划线。",
  SKILL_NAME_INVALID: "SKILL.md 的 frontmatter name 含非法字符。",
  NAME_MISMATCH: "frontmatter name 与现有技能名不一致；改名请先卸载再重建。",
  PACK_NOT_FOUND: "技能包不存在或已被卸载。",
  NOT_GIT: "仅 git 来源的技能包支持在线更新。",
  BUILTIN_NO_UNINSTALL: "内置技能包不可卸载。",
  BUILTIN_READ_ONLY: "内置技能不可修改。",
  TOO_MANY_JOBS: "进行中的任务太多，请等待完成或取消后再试。",
  CANCELLED: "已取消。",
};

function friendlySkillError(code?: string): string | null {
  return code ? (SKILL_ERROR_HINTS[code] ?? null) : null;
}

/** 结构化错误展示：人读原因 + 可展开的原始信息 + 凭证类错误的直达入口 */
function SkillErrorBox({
  error,
  onGoCredentials,
}: {
  error: { message: string; code?: string };
  onGoCredentials?: () => void;
}) {
  const hint = friendlySkillError(error.code);
  return (
    <div className="rounded-lg bg-destructive-soft px-2.5 py-2 text-sm text-destructive">
      {hint ? <p className="font-medium">{hint}</p> : null}
      <details className="mt-0.5">
        <summary className="cursor-pointer text-xs opacity-80">详细信息</summary>
        <pre className="mt-1 max-h-28 overflow-y-auto text-xs whitespace-pre-wrap break-words opacity-80">
          {error.message}
        </pre>
      </details>
      {onGoCredentials && error.code?.startsWith("CREDENTIAL_") ? (
        <Button variant="secondary" size="sm" className="mt-1.5" onClick={onGoCredentials}>
          去我的凭证
        </Button>
      ) : null}
    </div>
  );
}

type GitCredential = { code: string; name: string; filledKeys: string[] };

/** 拉取 kind=git 凭证下拉；失败置 credLoadError 提示（不阻塞弹窗其余字段） */
function useGitCredentials() {
  const [credentials, setCredentials] = useState<GitCredential[]>([]);
  const [credLoadError, setCredLoadError] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const all = await fetchMyCredentials();
        setCredentials(
          all
            .filter((c) => c.kind === "git")
            .map((c) => ({ code: c.code, name: c.name, filledKeys: c.filledKeys })),
        );
      } catch {
        setCredLoadError(true);
      }
    })();
  }, []);
  return { credentials, credLoadError };
}

/** 凭证未填令牌的行内提醒 */
function CredTokenHint({ selected }: { selected?: GitCredential }) {
  if (!selected || selected.filledKeys.includes("access_token")) return null;
  return (
    <p className="text-xs text-warning-foreground">
      该凭证尚未填写 access_token，请先到「我的凭证」补全后再操作。
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-[13px] font-semibold">{label}</span>
      {children}
    </label>
  );
}

export function SkillsPage() {
  const navigate = useNavigate();
  const [packs, setPacks] = useState<SkillPackDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repo, setRepo] = useState<SkillRepoConfigDTO | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncTip, setSyncTip] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyError, setBusyError] = useState<string | null>(null);
  // 全量清单/agent 级落点/托管（specs/2026-10-09-skills-git-hosting-design.md）
  const [inventory, setInventory] = useState<SkillInventoryDTO | null>(null);
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [installFor, setInstallFor] = useState<SkillInventoryRecordDTO | null>(null);
  const [installAgentId, setInstallAgentId] = useState("");
  const [hostTip, setHostTip] = useState<{ ok: boolean; text: string } | null>(null);
  const [repoInstallSlug, setRepoInstallSlug] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [packList, repoCfg] = await Promise.all([fetchPacks(), fetchSkillRepo()]);
      setPacks(packList);
      setRepo(repoCfg);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // 全量清单失败不阻塞主列表（后端未装配时优雅降级隐藏该区块）
    fetchSkillInventory()
      .then(setInventory)
      .catch(() => setInventory(null));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setBusyError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setBusyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    setSyncTip(null);
    try {
      const r = await syncSkillRepo();
      setSyncTip({ ok: true, text: r.message });
      await reload();
    } catch (e) {
      setSyncTip({ ok: false, text: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  const openInstallPicker = async (record: SkillInventoryRecordDTO) => {
    setInstallFor(record);
    setInstallAgentId("");
    if (agents.length === 0) {
      try {
        setAgents(await fetchAgents());
      } catch {
        setAgents([]);
      }
    }
  };

  const runInstallToAgent = async (overwrite: boolean) => {
    if (!installFor || !installAgentId || !installFor.packId) return;
    setBusy(true);
    setBusyError(null);
    try {
      await installSkillToAgent({
        agentId: installAgentId,
        from: { kind: "pack", packId: installFor.packId, skill: installFor.name },
        overwrite: overwrite || undefined,
      });
      setInstallFor(null);
      await reload();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "SKILL_EXISTS" && !overwrite) {
        if (window.confirm(`该 agent 已有同名技能「${installFor.name}」，确定覆盖？`)) {
          await runInstallToAgent(true);
        }
      } else {
        setBusyError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const runHost = async (record: SkillInventoryRecordDTO) => {
    if (!record.agentId) return;
    setBusy(true);
    setHostTip(null);
    setBusyError(null);
    try {
      const r = await hostSkill(record.agentId, record.name);
      setHostTip({
        ok: true,
        text: `已${r.action === "created" ? "创建" : "更新"}托管包「${r.packSlug}」，正在推送到 git 仓库`,
      });
      await reload();
    } catch (e) {
      setHostTip({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const runRepoInstall = async (replace: boolean) => {
    const slug = repoInstallSlug.trim();
    if (!slug) return;
    setBusy(true);
    setBusyError(null);
    try {
      const r = await repoInstallSkill(slug, replace || undefined);
      setSyncTip({ ok: true, text: `已回装「${slug}」${r.replaced ? "（替换原包）" : ""}` });
      setRepoInstallSlug("");
      await reload();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "PACK_EXISTS" && !replace) {
        if (window.confirm(`本地已存在「${slug}」，确定替换？`)) await runRepoInstall(true);
      } else {
        setBusyError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-7">
      <PageHeader
        className="mb-5"
        title="技能包"
        description="为智能体安装可插拔的技能能力"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                // 带草稿意图进对话（体验轮）：不再裸落通用会话让用户重新描述需求
                sessionStorage.setItem(
                  ASSIST_DRAFT_STORAGE_KEY,
                  "帮我创建一个新的技能包：\n- 技能名称：\n- 解决什么问题：\n- 期望的触发场景：\n请先和我确认需求，再生成完整的 SKILL.md（含 frontmatter）。",
                );
                navigate(`/?agent=${BUILTIN_ASSIST_AGENT_ID}`);
              }}
            >
              <Sparkles aria-hidden="true" size={14} className="inline" />
              AI 生成
            </Button>
            <Button variant="secondary" onClick={() => setRepoOpen(true)}>
              <GitBranch aria-hidden="true" size={14} className="inline" />
              Git 仓库
            </Button>
            <Button onClick={() => setInstallOpen(true)}>＋ 安装技能包</Button>
          </>
        }
      />
      {repo && (
        <Card className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
          <GitBranch aria-hidden="true" size={14} className="text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-xs" title={repo.repoUrl}>
            {repo.repoUrl}
          </span>
          {repo.lastSyncStatus === "ok" && <Badge tone="success">同步正常</Badge>}
          {repo.lastSyncStatus === "failed" && <Badge tone="warning">同步失败</Badge>}
          {repo.lastSyncStatus === "skipped" && <Badge>同步停用</Badge>}
          {!repo.lastSyncStatus && <Badge>待首次同步</Badge>}
          {repo.lastSyncAt && (
            <span className="text-xs text-muted-foreground">
              最近同步 {new Date(repo.lastSyncAt).toLocaleString()}
            </span>
          )}
          <span className="flex-1" />
          <Input
            className="h-8 w-36"
            placeholder="回装 slug"
            value={repoInstallSlug}
            onChange={(e) => setRepoInstallSlug(e.target.value)}
            aria-label="回装技能包 slug"
          />
          <Button
            variant="secondary"
            disabled={syncing || busy || !repoInstallSlug.trim()}
            onClick={() => void runRepoInstall(false)}
          >
            回装
          </Button>
          <Button variant="secondary" onClick={runSync} disabled={syncing}>
            <RefreshCw aria-hidden="true" size={14} className={cn(syncing && "animate-spin")} />
            {syncing ? "同步中…" : "立即同步"}
          </Button>
        </Card>
      )}
      {repo?.lastSyncStatus === "failed" && repo.lastSyncError && (
        <div className="mb-3 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {repo.lastSyncError}
        </div>
      )}
      {syncTip && (
        <div
          className={cn(
            "mb-3 rounded-lg px-3 py-2 text-sm",
            syncTip.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive",
          )}
        >
          {syncTip.text}
        </div>
      )}
      {busyError && (
        <div className="mb-3 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {busyError}
        </div>
      )}
      {hostTip && (
        <div
          className={cn(
            "mb-3 rounded-lg px-3 py-2 text-sm",
            hostTip.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive",
          )}
        >
          {hostTip.text}
        </div>
      )}
      {inventory && inventory.records.length > 0 && (
        <Card className="mb-3 p-3">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-sm font-medium">全部技能</span>
            <span className="text-xs text-muted-foreground">
              {inventory.records.length} 项 · 含 agent 工作区与 git 托管状态
            </span>
          </div>
          <div className="divide-y divide-border">
            {inventory.records.map((r) => (
              <div
                key={`${r.origin}:${r.id}:${r.agentId ?? ""}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm"
              >
                <span className="font-medium">{r.name}</span>
                {r.origin === "pack" ? (
                  <Badge>{originLabel(r.packSource)}</Badge>
                ) : (
                  <Badge tone="info">agent 工作区</Badge>
                )}
                {r.origin === "agent" && r.agentName && (
                  <span className="text-xs text-muted-foreground">@{r.agentName}</span>
                )}
                {r.origin === "pack" && r.packSlug && (
                  <span className="font-mono text-xs text-muted-foreground">{r.packSlug}</span>
                )}
                {r.origin === "pack" && !r.enabled && <Badge tone="warning">已停用</Badge>}
                {r.hosted && <Badge tone="success">已托管</Badge>}
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={r.description}
                >
                  {r.description}
                </span>
                {r.origin === "pack" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void openInstallPicker(r)}
                  >
                    安装到 agent
                  </Button>
                )}
                {r.origin === "agent" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void runHost(r)}
                  >
                    提升托管
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
      {loadError && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </Button>
        </div>
      )}
      {loading && packs.length === 0 ? (
        <div className="space-y-3" aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : packs.length === 0 && !loadError ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          暂无技能包，点击「安装技能包」添加
        </div>
      ) : (
        <div className="space-y-3">
          {packs.map((p) => (
            <PackCard
              key={p.id}
              pack={p}
              disabled={busy}
              onTogglePack={(en) => wrap(() => setPackEnabled(p.id, en))}
              onToggleSkill={(sid, en) => wrap(() => setSkillEnabled(sid, en))}
              onUninstall={() => wrap(() => uninstallPack(p.id))}
              onUpdated={() => reload()}
            />
          ))}
        </div>
      )}
      {installOpen && (
        <InstallDialog
          onClose={() => setInstallOpen(false)}
          onInstalled={async () => {
            setInstallOpen(false);
            await reload();
          }}
        />
      )}
      {repoOpen && (
        <SkillRepoDialog
          repo={repo}
          onClose={() => setRepoOpen(false)}
          onSaved={async () => {
            setRepoOpen(false);
            await reload();
          }}
        />
      )}
      {installFor && (
        <DialogShell
          title={`安装「${installFor.name}」到 agent`}
          subtitle="复制到该 agent 的工作区技能目录（.agents/skills），仅该 agent 会话可用；同名技能需确认覆盖"
          onClose={() => setInstallFor(null)}
          ariaLabel="安装到 agent"
          footer={
            <>
              <span className="flex-1" />
              <Button variant="secondary" size="sm" onClick={() => setInstallFor(null)}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={busy || !installAgentId}
                onClick={() => void runInstallToAgent(false)}
              >
                安装
              </Button>
            </>
          }
        >
          <div className="space-y-2">
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有可选 agent（先创建智能体）</p>
            ) : (
              <Select
                value={installAgentId}
                onChange={(e) => setInstallAgentId(e.target.value)}
                aria-label="选择 agent"
              >
                <option value="">选择 agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </DialogShell>
      )}
    </div>
  );
}

/** pack 来源徽章文案 */
function originLabel(source?: string): string {
  switch (source) {
    case "git":
      return "git 包";
    case "paste":
      return "自建";
    case "upload":
      return "上传";
    case "builtin":
      return "内置";
    default:
      return "技能包";
  }
}

/** 无凭证内嵌的 HTTPS 地址（与后端 UserSkillRepoInputSchema 同规的浅校验） */
const isCleanHttpsUrl = (v: string) => /^https:\/\/[^\s@]+$/.test(v.trim());

function SkillRepoDialog({
  repo,
  onClose,
  onSaved,
}: {
  repo: SkillRepoConfigDTO | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [repoUrl, setRepoUrl] = useState(repo?.repoUrl ?? "");
  const [branch, setBranch] = useState(repo?.branch ?? "main");
  const [credentialCode, setCredentialCode] = useState(repo?.credentialCode ?? "");
  const { credentials, credLoadError } = useGitCredentials();
  const [probeTip, setProbeTip] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = credentials.find((c) => c.code === credentialCode);
  const canSubmit = isCleanHttpsUrl(repoUrl) && credentialCode !== "";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title="技能 Git 仓库"
      subtitle="绑定后，自建与 AI 生成的技能（含启停、卸载）自动同步到该仓库，以提交历史留痕"
      onClose={onClose}
      ariaLabel="技能 Git 仓库"
      footer={
        <>
          {repo && (
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmUnbind(true)}
            >
              解绑仓库
            </Button>
          )}
          <span className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !canSubmit}
            onClick={() =>
              run(async () => {
                const r = await verifySkillRepo({
                  repoUrl: repoUrl.trim(),
                  credentialCode,
                });
                setProbeTip({ ok: r.ok, text: r.message });
              })
            }
          >
            测试连接
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={busy || !canSubmit}
            onClick={() =>
              run(async () => {
                await saveSkillRepo({
                  repoUrl: repoUrl.trim(),
                  credentialCode,
                  branch: branch.trim() || "main",
                });
                onSaved();
              })
            }
          >
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <Field label="仓库地址（HTTPS，不含凭证）">
        <Input
          mono
          placeholder="https://gitee.com/user/my-skills.git"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="分支">
          <Input placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </Field>
        <Field label="git PAT 凭证">
          <Select value={credentialCode} onChange={(e) => setCredentialCode(e.target.value)}>
            <option value="">选择凭证…</option>
            {credentials.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
                {c.filledKeys.includes("access_token") ? "" : "（未填令牌）"}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {credLoadError && (
        <p className="text-xs text-warning-foreground">
          凭证列表加载失败，请刷新重试或前往「我的凭证」。
        </p>
      )}
      <CredTokenHint selected={selected} />
      <p className="text-xs leading-5 text-muted-foreground">
        请确保该仓库可写且仅你自己可见敏感技能内容；解绑不影响本地技能。
      </p>
      {probeTip && (
        <div
          className={cn(
            "rounded-lg px-2.5 py-2 text-sm",
            probeTip.ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive",
          )}
        >
          {probeTip.text}
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-destructive-soft px-2.5 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <ConfirmDialog
        open={confirmUnbind}
        title="解绑技能仓库？"
        description="本地技能不受影响，仅停止自动同步；仓库中已同步的历史提交会保留。"
        confirmText="解绑"
        destructive
        onConfirm={() =>
          run(async () => {
            await saveSkillRepo({ repoUrl: "", credentialCode: "" });
            setConfirmUnbind(false);
            onSaved();
          })
        }
        onCancel={() => setConfirmUnbind(false)}
      />
    </DialogShell>
  );
}

function PackCard({
  pack,
  disabled,
  onTogglePack,
  onToggleSkill,
  onUninstall,
  onUpdated,
}: {
  pack: SkillPackDTO;
  disabled: boolean;
  onTogglePack: (enabled: boolean) => void;
  onToggleSkill: (skillId: string, enabled: boolean) => void;
  onUninstall: () => void;
  /** 更新任务成功后由卡片回调（父级 reload packs） */
  onUpdated: () => void | Promise<void>;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  // 更新任务化：进度阶段 + 取消 + 结构化错误（体验轮）
  const [job, setJob] = useState<SkillJobView | null>(null);
  const [updateError, setUpdateError] = useState<{ message: string; code?: string } | null>(null);
  const jobIdRef = useRef<string | null>(null);
  // 卸载影响面：确认框打开时拉引用 agent 名单（拉不到回落通用文案）
  const [usage, setUsage] = useState<PackUsageDTO | null>(null);
  // SKILL.md 预览
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();

  const jobRunning = job !== null && (job.status === "queued" || job.status === "running");
  const inert = disabled || jobRunning;
  const cs = credentialStatus(pack);

  const startUpdate = async (): Promise<void> => {
    setUpdateError(null);
    try {
      const started = await startSkillJob({ op: "update", id: pack.id });
      jobIdRef.current = started.jobId;
      const done = await waitSkillJob(started.jobId, setJob);
      if (done.status === "failed") {
        setUpdateError({ message: done.error ?? "更新失败", code: done.errorCode });
      } else if (done.status === "done") {
        await onUpdated();
      }
    } catch (e) {
      setUpdateError({ message: (e as Error).message });
    } finally {
      jobIdRef.current = null;
      setJob(null);
    }
  };

  const cancelUpdate = async (): Promise<void> => {
    const id = jobIdRef.current;
    if (id) await cancelSkillJob(id).catch(() => {});
  };

  const openConfirmUninstall = (): void => {
    setUsage(null);
    setConfirmUninstall(true);
    void fetchPackUsage(pack.id)
      .then(setUsage)
      .catch(() => setUsage(null));
  };

  const openPreview = async (name: string): Promise<void> => {
    setPreviewError(undefined);
    setPreviewLoading(true);
    setPreview({ name, content: "" });
    try {
      const content = await fetchSkillDoc(pack.id, name);
      setPreview({ name, content });
    } catch (e) {
      setPreview(null);
      setPreviewError(`${name}：${(e as Error).message}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const usageText = (() => {
    const names = usage?.agents.map((a) => a.name) ?? null;
    if (names === null) return "卸载后引用它的智能体将失去对应技能。";
    if (names.length === 0) return "当前没有智能体引用该技能包，可以放心卸载。";
    return `该技能包正被 ${names.length} 个智能体引用（${names.join("、")}），卸载后它们将失去对应技能。`;
  })();

  return (
    <Card className={cn("p-4", !pack.enabled && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{pack.name}</span>
            {pack.builtin && <Badge tone="info">内置</Badge>}
            <Badge>{pack.source.kind}</Badge>
            {pack.version && <span className="text-xs text-muted-foreground">v{pack.version}</span>}
          </div>
          {pack.description && (
            <div className="mt-0.5 text-xs text-muted-foreground">{pack.description}</div>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {cs.missing.length > 0 && <Badge tone="warning">缺凭证：{cs.missing.join(", ")}</Badge>}
            {cs.configured.length > 0 && (
              <Badge tone="success">已配：{cs.configured.join(", ")}</Badge>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            启用
            <Switch checked={pack.enabled} disabled={inert} onCheckedChange={onTogglePack} />
          </label>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {pack.skills.length} 技能
          </Button>
          {pack.source.kind === "git" ? (
            jobRunning ? (
              <>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 aria-hidden="true" size={12} className="animate-spin" />
                  <span className="max-w-40 truncate" title={job?.stage}>
                    {job?.stage ?? "更新中…"}
                  </span>
                </span>
                <Button variant="secondary" size="sm" onClick={() => void cancelUpdate()}>
                  取消
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void startUpdate()}
                disabled={disabled}
              >
                更新
              </Button>
            )
          ) : null}
          {!pack.builtin && (
            <Button variant="danger" size="sm" onClick={openConfirmUninstall} disabled={inert}>
              删除
            </Button>
          )}
        </div>
      </div>
      {updateError ? (
        <div className="mt-2">
          <SkillErrorBox error={updateError} onGoCredentials={() => navigate("/credentials")} />
        </div>
      ) : null}
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          {pack.skills.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-2.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-sm"
            >
              <Switch
                checked={s.enabled}
                disabled={inert}
                onCheckedChange={(en) => onToggleSkill(s.id, en)}
              />
              <span className="font-mono text-[13px]">{s.name}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {s.description}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto shrink-0"
                title="预览 SKILL.md"
                onClick={() => void openPreview(s.name)}
              >
                <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                预览
              </Button>
            </div>
          ))}
        </div>
      )}
      {previewError ? <p className="mt-2 text-xs text-destructive">{previewError}</p> : null}

      <ConfirmDialog
        open={confirmUninstall}
        title={`卸载技能包 ${pack.name}？`}
        description={usageText}
        confirmText="卸载"
        destructive
        onConfirm={() => {
          setConfirmUninstall(false);
          onUninstall();
        }}
        onCancel={() => setConfirmUninstall(false)}
      />

      {preview ? (
        <DialogShell
          title={`预览：${preview.name}`}
          subtitle="SKILL.md 原文（修改 git 源请到上游仓库，自建源可在对话中让技能工坊升级）"
          onClose={() => setPreview(null)}
          ariaLabel="技能预览"
          footer={
            <Button variant="secondary" size="sm" onClick={() => setPreview(null)}>
              关闭
            </Button>
          }
        >
          <div className="max-h-[60vh] overflow-y-auto">
            <article className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown>
            </article>
          </div>
        </DialogShell>
      ) : null}
    </Card>
  );
}

function InstallDialog({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"git" | "upload" | "paste">("git");
  const [gitUrl, setGitUrl] = useState("");
  const [gitSubPath, setGitSubPath] = useState("");
  const [gitSlug, setGitSlug] = useState("");
  const [credentialCode, setCredentialCode] = useState("");
  const { credentials, credLoadError } = useGitCredentials();
  const [pasteContent, setPasteContent] = useState("");
  const [pasteSlug, setPasteSlug] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 任务化安装：进度阶段 + 可取消（git 克隆最长 120s，不再只有按钮文字硬扛）
  const [job, setJob] = useState<SkillJobView | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const selectedCred = credentials.find((c) => c.code === credentialCode);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let started: { jobId: string };
      if (tab === "git") {
        if (!gitUrl.trim()) throw new Error("请填写 git 地址");
        started = await startSkillJob({
          op: "install-git",
          source: {
            kind: "git",
            url: gitUrl.trim(),
            subPath: gitSubPath.trim() || undefined,
            slug: gitSlug.trim() || undefined,
            credentialCode: credentialCode || undefined,
          },
        });
      } else if (tab === "upload") {
        if (!fileContent) throw new Error("请选择文件");
        started = await startSkillJob({
          op: "install-upload",
          filename: fileName || "skill.md",
          content: fileContent,
        });
      } else {
        if (!pasteContent.trim()) throw new Error("请粘贴 SKILL.md 内容");
        started = await startSkillJob({
          op: "install-paste",
          source: {
            kind: "paste",
            content: pasteContent,
            slug: pasteSlug.trim() || undefined,
          },
        });
      }
      jobIdRef.current = started.jobId;
      const done = await waitSkillJob(started.jobId, setJob);
      if (done.status === "failed") {
        setError({ message: done.error ?? "安装失败", code: done.errorCode });
        return;
      }
      if (done.status === "cancelled") {
        return; // 用户主动取消：安静复位，不提示错误
      }
      onInstalled();
    } catch (e) {
      setError({ message: (e as Error).message });
    } finally {
      jobIdRef.current = null;
      setJob(null);
      setBusy(false);
    }
  };

  const cancelInstall = async (): Promise<void> => {
    const id = jobIdRef.current;
    if (id) await cancelSkillJob(id).catch(() => {});
  };

  return (
    <DialogShell
      title="安装技能包"
      subtitle="Git 仓库 / 上传 SKILL.md / 直接粘贴内容，三选一"
      onClose={() => {
        if (!busy) onClose();
      }}
      ariaLabel="安装技能包"
      footer={
        <>
          {busy && job ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" size={12} className="animate-spin" />
              <span className="truncate" title={job.stage}>
                {job.stage}
              </span>
            </span>
          ) : error ? (
            <span className="min-w-0 flex-1 text-xs text-destructive">
              {friendlySkillError(error.code) ?? error.message}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {busy ? (
            <Button variant="secondary" size="sm" onClick={() => void cancelInstall()}>
              取消安装
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onClose}>
              取消
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? (job?.status === "queued" ? "排队中…" : "安装中…") : "安装"}
          </Button>
        </>
      }
    >
      <Segmented
        name="安装方式"
        options={[
          { value: "git", label: "Git 仓库" },
          { value: "upload", label: "上传文件" },
          { value: "paste", label: "粘贴文本" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {error ? (
        <SkillErrorBox error={error} onGoCredentials={() => navigate("/credentials")} />
      ) : null}
      {tab === "git" && (
        <>
          <Field label="仓库地址">
            <Input
              mono
              placeholder="https://github.com/user/skills-repo（支持 GitHub / Gitee / GitLab·极狐）"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
            />
          </Field>
          <Field label="技能目录（可选，留空安装全部）">
            <Input
              mono
              placeholder="skills/.../skill-name"
              value={gitSubPath}
              onChange={(e) => setGitSubPath(e.target.value)}
            />
          </Field>
          <Field label="slug（可选，默认取仓库名；小写字母/数字/中划线）">
            <Input value={gitSlug} onChange={(e) => setGitSlug(e.target.value)} />
          </Field>
          <Field label="git 凭证">
            <Select value={credentialCode} onChange={(e) => setCredentialCode(e.target.value)}>
              <option value="">不使用凭证（公开仓库匿名拉取）</option>
              {credentials.map((c) => {
                const unfilled = !c.filledKeys.includes("access_token");
                return (
                  <option key={c.code} value={c.code} disabled={unfilled}>
                    {c.name}
                    {unfilled ? "（未填令牌，请先补全）" : ""}
                  </option>
                );
              })}
            </Select>
          </Field>
          {credLoadError && (
            <p className="flex items-center gap-2 text-xs text-warning-foreground">
              凭证列表加载失败，请刷新重试，或
              <button
                type="button"
                className="text-primary underline underline-offset-2"
                onClick={() => navigate("/credentials")}
              >
                前往「我的凭证」
              </button>
              。
            </p>
          )}
          {!credLoadError && credentials.length === 0 && (
            <p className="text-xs leading-5 text-muted-foreground">
              还没有 git 凭证——
              <button
                type="button"
                className="text-primary underline underline-offset-2"
                onClick={() => navigate("/credentials")}
              >
                前往「我的凭证」
              </button>
              创建 kind=git 的 PAT 凭证并填好令牌，即可安装私有仓库。
            </p>
          )}
          <CredTokenHint selected={selectedCred} />
        </>
      )}
      {tab === "upload" && (
        <Field label="SKILL.md 文件">
          <input
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            className="text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              f.text().then(setFileContent);
            }}
          />
        </Field>
      )}
      {tab === "paste" && (
        <>
          <Field label="SKILL.md 内容">
            <Textarea
              mono
              rows={8}
              placeholder={"---\nname: my-skill\ndescription: ...\n---\n# 指令正文"}
              value={pasteContent}
              onChange={(e) => setPasteContent(e.target.value)}
            />
          </Field>
          <Field label="slug（可选，默认取 frontmatter name）">
            <Input value={pasteSlug} onChange={(e) => setPasteSlug(e.target.value)} />
          </Field>
        </>
      )}
    </DialogShell>
  );
}
