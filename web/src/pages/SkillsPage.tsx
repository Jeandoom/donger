import { ChevronDown, ChevronRight, GitBranch, RefreshCw, Sparkles } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { BUILTIN_ASSIST_AGENT_ID } from "../lib/assist";
import {
  credentialStatus,
  fetchMyCredentials,
  fetchPacks,
  fetchSkillRepo,
  installPack,
  installUpload,
  type SkillPackDTO,
  type SkillRepoConfigDTO,
  saveSkillRepo,
  setPackEnabled,
  setSkillEnabled,
  syncSkillRepo,
  uninstallPack,
  updatePack,
  verifySkillRepo,
} from "../lib/skills";
import { cn } from "../lib/utils";

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
  const [_reloadSeq, setReloadSeq] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repo, setRepo] = useState<SkillRepoConfigDTO | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncTip, setSyncTip] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyError, setBusyError] = useState<string | null>(null);

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
              onClick={() => navigate(`/?agent=${BUILTIN_ASSIST_AGENT_ID}`)}
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
      {loadError && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => setReloadSeq((v) => v + 1)}>
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
              onUpdate={p.source.kind === "git" ? () => wrap(() => updatePack(p.id)) : undefined}
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
    </div>
  );
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
  onUpdate,
}: {
  pack: SkillPackDTO;
  disabled: boolean;
  onTogglePack: (enabled: boolean) => void;
  onToggleSkill: (skillId: string, enabled: boolean) => void;
  onUninstall: () => void;
  onUpdate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const cs = credentialStatus(pack);
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
            <Switch checked={pack.enabled} disabled={disabled} onCheckedChange={onTogglePack} />
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
          {onUpdate && (
            <Button variant="secondary" size="sm" onClick={onUpdate} disabled={disabled}>
              更新
            </Button>
          )}
          {!pack.builtin && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmUninstall(true)}
              disabled={disabled}
            >
              删除
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          {pack.skills.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-2.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-sm"
            >
              <Switch
                checked={s.enabled}
                disabled={disabled}
                onCheckedChange={(en) => onToggleSkill(s.id, en)}
              />
              <span className="font-mono text-[13px]">{s.name}</span>
              <span className="truncate text-xs text-muted-foreground">{s.description}</span>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmUninstall}
        title={`卸载技能套装 ${pack.name}？`}
        description="卸载后引用它的智能体将失去对应技能。"
        confirmText="卸载"
        destructive
        onConfirm={() => {
          setConfirmUninstall(false);
          onUninstall();
        }}
        onCancel={() => setConfirmUninstall(false)}
      />
    </Card>
  );
}

function InstallDialog({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedCred = credentials.find((c) => c.code === credentialCode);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "git") {
        if (!gitUrl.trim()) throw new Error("请填写 git 地址");
        await installPack({
          kind: "git",
          url: gitUrl.trim(),
          subPath: gitSubPath.trim() || undefined,
          slug: gitSlug.trim() || undefined,
          credentialCode: credentialCode || undefined,
        });
      } else if (tab === "upload") {
        if (!fileContent) throw new Error("请选择文件");
        await installUpload(fileName || "skill.md", fileContent);
      } else {
        if (!pasteContent.trim()) throw new Error("请粘贴 SKILL.md 内容");
        await installPack({
          kind: "paste",
          content: pasteContent,
          slug: pasteSlug.trim() || undefined,
        });
      }
      onInstalled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title="安装技能"
      subtitle="Git 仓库 / 上传 SKILL.md / 直接黏贴内容，三选一"
      onClose={onClose}
      ariaLabel="安装技能"
      footer={
        <>
          {error ? (
            <span className="min-w-0 flex-1 truncate text-xs text-destructive">{error}</span>
          ) : (
            <span className="flex-1" />
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? "安装中…" : "安装"}
          </Button>
        </>
      }
    >
      <Segmented
        name="安装方式"
        options={[
          { value: "git", label: "Git 仓库" },
          { value: "upload", label: "上传文件" },
          { value: "paste", label: "黏贴文本" },
        ]}
        value={tab}
        onChange={setTab}
      />
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
          <Field label="slug（可选，默认取仓库名）">
            <Input value={gitSlug} onChange={(e) => setGitSlug(e.target.value)} />
          </Field>
          <Field label="git 凭证">
            <Select value={credentialCode} onChange={(e) => setCredentialCode(e.target.value)}>
              <option value="">不使用凭证（公开仓库匿名拉取）</option>
              {credentials.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                  {c.filledKeys.includes("access_token") ? "" : "（未填令牌）"}
                </option>
              ))}
            </Select>
          </Field>
          {credLoadError && (
            <p className="text-xs text-warning-foreground">
              凭证列表加载失败，请刷新重试或前往「我的凭证」。
            </p>
          )}
          <CredTokenHint selected={selectedCred} />
          {!credentialCode && (
            <p className="text-xs leading-5 text-muted-foreground">
              GitLab / Gitee 等私有仓库请先在「我的凭证」建 kind=git 的 PAT
              凭证并填好令牌，再在此勾选后安装。
            </p>
          )}
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
