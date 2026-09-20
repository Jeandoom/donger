import { GitBranch, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
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

export function SkillsPage() {
  const navigate = useNavigate();
  const [packs, setPacks] = useState<SkillPackDTO[]>([]);
  const [installOpen, setInstallOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repo, setRepo] = useState<SkillRepoConfigDTO | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncTip, setSyncTip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [packList, repoCfg] = await Promise.all([fetchPacks(), fetchSkillRepo()]);
      setPacks(packList);
      setRepo(repoCfg);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    setSyncTip(null);
    try {
      const r = await syncSkillRepo();
      setSyncTip(r.message);
      await reload();
    } catch (e) {
      setSyncTip((e as Error).message);
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
            <Button onClick={() => setInstallOpen(true)}>+ 安装技能包</Button>
          </>
        }
      />
      {repo && (
        <Card className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
          <GitBranch aria-hidden="true" size={14} className="text-muted-foreground" />
          <span className="font-mono text-xs">{repo.repoUrl}</span>
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
      {(repo?.lastSyncError || syncTip) && (
        <div
          className={cn(
            "mb-3 rounded-lg px-3 py-2 text-sm",
            (repo?.lastSyncStatus === "failed" || syncTip?.startsWith("推送失败")) &&
              "bg-destructive-soft text-destructive",
          )}
        >
          {syncTip ?? repo?.lastSyncError}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {packs.length === 0 ? (
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
  const [credentials, setCredentials] = useState<
    Array<{ code: string; name: string; filledKeys: string[] }>
  >([]);
  const [credLoadError, setCredLoadError] = useState(false);
  const [probeTip, setProbeTip] = useState<string | null>(null);
  const [probeError, setProbeError] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[560px] rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">技能 Git 仓库</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          绑定后，你自建与 AI
          生成的技能（含启停、卸载等管理操作）会自动同步到该仓库，以提交历史留痕。
          请确保该仓库可写且仅你自己可见敏感技能内容。
        </p>
        <div className="space-y-2">
          <input
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
            placeholder="https://gitee.com/user/my-skills.git（HTTPS，不含凭证）"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className="w-40 rounded-md border border-border px-3 py-2 text-sm"
              placeholder="分支（默认 main）"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
            <select
              className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm"
              value={credentialCode}
              onChange={(e) => setCredentialCode(e.target.value)}
            >
              <option value="">选择 git PAT 凭证…</option>
              {credentials.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                  {c.filledKeys.includes("access_token") ? "" : "（未填令牌）"}
                </option>
              ))}
            </select>
          </div>
          {credLoadError && (
            <div className="text-xs text-warning">
              凭证列表加载失败，请刷新重试或前往「我的凭证」。
            </div>
          )}
          {credentialCode && selected && !selected.filledKeys.includes("access_token") && (
            <div className="text-xs text-warning">
              该凭证尚未填写 access_token，请先到「我的凭证」补全后再测试/同步。
            </div>
          )}
        </div>
        {probeTip && (
          <div className={cn("mt-2 text-sm", probeError ? "text-destructive" : "text-success")}>
            {probeTip}
          </div>
        )}
        {error && <div className="mt-2 text-sm text-destructive">{error}</div>}
        <div className="mt-4 flex items-center gap-2">
          {repo && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() => setConfirmUnbind(true)}
            >
              解绑仓库
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy || !canSubmit}
            onClick={() =>
              run(async () => {
                const r = await verifySkillRepo({
                  repoUrl: repoUrl.trim(),
                  credentialCode,
                });
                setProbeTip(r.message);
                setProbeError(!r.ok);
              })
            }
          >
            测试连接
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
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
          </button>
        </div>
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
      </div>
    </div>
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
      <div className="flex items-start justify-between gap-3">
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
          <label className="flex cursor-pointer items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={pack.enabled}
              disabled={disabled}
              onChange={(e) => onTogglePack(e.target.checked)}
            />
            启用
          </label>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            {pack.skills.length} 技能 {expanded ? "▲" : "▼"}
          </button>
          {onUpdate && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={onUpdate}
              disabled={disabled}
            >
              更新
            </button>
          )}
          {!pack.builtin && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmUninstall(true)}
              disabled={disabled}
            >
              删除
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {pack.skills.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => onToggleSkill(s.id, e.target.checked)}
              />
              <span className="font-mono">{s.name}</span>
              <span className="truncate text-xs text-muted-foreground">{s.description}</span>
            </label>
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
  const [pasteContent, setPasteContent] = useState("");
  const [pasteSlug, setPasteSlug] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[520px] rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">安装技能</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground">
            ✕
          </button>
        </div>
        <div className="mb-3 flex gap-2 text-sm">
          {(["git", "upload", "paste"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-3 py-1",
                tab === t ? "bg-muted text-accent-foreground" : "hover:bg-muted",
              )}
            >
              {t === "git" ? "Git 仓库" : t === "upload" ? "上传文件" : "黏贴文本"}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          {tab === "git" && (
            <>
              <input
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
                placeholder="https://github.com/user/skills-repo"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
              />
              <input
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
                placeholder="技能目录（可选，如 skills/.../skill-name；留空安装全部）"
                value={gitSubPath}
                onChange={(e) => setGitSubPath(e.target.value)}
              />
              <input
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
                placeholder="slug（可选，默认取仓库名）"
                value={gitSlug}
                onChange={(e) => setGitSlug(e.target.value)}
              />
            </>
          )}
          {tab === "upload" && (
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
          )}
          {tab === "paste" && (
            <>
              <textarea
                className="h-48 w-full rounded-md border border-border px-3 py-2 font-mono text-xs"
                placeholder={"---\nname: my-skill\ndescription: ...\n---\n# 指令正文"}
                value={pasteContent}
                onChange={(e) => setPasteContent(e.target.value)}
              />
              <input
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
                placeholder="slug（可选，默认取 frontmatter name）"
                value={pasteSlug}
                onChange={(e) => setPasteSlug(e.target.value)}
              />
            </>
          )}
        </div>
        {error && <div className="mt-2 text-sm text-destructive">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "安装中…" : "安装"}
          </button>
        </div>
      </div>
    </div>
  );
}
