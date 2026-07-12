import { useCallback, useEffect, useState } from "react";
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
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">技能管理</h1>
        <button
          type="button"
          onClick={() => setInstallOpen(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
        >
          + 安装技能
        </button>
      </div>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {packs.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无技能。点击“安装技能”添加。</div>
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
  const cs = credentialStatus(pack);
  return (
    <div className={cn("rounded-lg border border-border p-3", !pack.enabled && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{pack.name}</span>
            {pack.builtin && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                预装
              </span>
            )}
            <span className="text-xs text-muted-foreground">{pack.source.kind}</span>
            {pack.version && <span className="text-xs text-muted-foreground">v{pack.version}</span>}
          </div>
          {pack.description && (
            <div className="mt-0.5 text-xs text-muted-foreground">{pack.description}</div>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {cs.missing.length > 0 && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600">
                缺凭证：{cs.missing.join(", ")}
              </span>
            )}
            {cs.configured.length > 0 && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600">
                已配：{cs.configured.join(", ")}
              </span>
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
              onClick={() => {
                if (window.confirm(`卸载技能套装 ${pack.name}？`)) onUninstall();
              }}
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
    </div>
  );
}

function InstallDialog({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const [tab, setTab] = useState<"git" | "upload" | "paste">("git");
  const [gitUrl, setGitUrl] = useState("");
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
        await installPack({ kind: "git", url: gitUrl.trim(), slug: gitSlug.trim() || undefined });
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
      <div className="w-[520px] rounded-lg bg-background p-4 shadow-lg">
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
                tab === t ? "bg-accent text-accent-foreground" : "hover:bg-accent",
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
            className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
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
