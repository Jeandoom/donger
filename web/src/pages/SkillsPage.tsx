import { Sparkles } from "lucide-react";
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
  fetchPacks,
  installPack,
  installUpload,
  type SkillPackDTO,
  setPackEnabled,
  setSkillEnabled,
  uninstallPack,
  updatePack,
} from "../lib/skills";
import { cn } from "../lib/utils";

export function SkillsPage() {
  const navigate = useNavigate();
  const [packs, setPacks] = useState<SkillPackDTO[]>([]);
  const [installOpen, setInstallOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setPacks(await fetchPacks());
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
            <Button onClick={() => setInstallOpen(true)}>+ 安装技能包</Button>
          </>
        }
      />
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
