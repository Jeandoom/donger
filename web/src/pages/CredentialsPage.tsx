import { useCallback, useEffect, useState } from "react";
import {
  type CredentialEntryDTO,
  deleteCredential,
  fetchCredentials,
  setCredential,
} from "../lib/skills";

export function CredentialsPage() {
  const [entries, setEntries] = useState<CredentialEntryDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    try {
      setEntries(await fetchCredentials());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (!newKey.trim() || !newValue) return;
    setBusy(true);
    try {
      await setCredential(newKey.trim(), newValue, newLabel.trim() || undefined);
      setNewKey("");
      setNewValue("");
      setNewLabel("");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <h1 className="mb-4 text-lg font-semibold">凭证管理</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        凭证随用户保存（跨技能复用）。技能运行时按需注入为环境变量。
      </p>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mb-4 rounded-lg border border-border p-3">
        <div className="mb-2 text-sm font-medium">新增 / 覆盖凭证</div>
        <div className="flex flex-wrap gap-2">
          <input
            className="w-40 rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="KEY（如 GITHUB_TOKEN）"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            className="w-40 rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="标签（可选）"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <input
            className="w-56 rounded-md border border-border px-2 py-1.5 text-sm"
            type="password"
            placeholder="值"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
          <button
            type="button"
            onClick={add}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无凭证。</div>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <div
              key={e.key}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{e.key}</span>
                  {e.label && <span className="text-xs text-muted-foreground">{e.label}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {e.usedBy.length > 0 ? `被引用：${e.usedBy.join(", ")}` : "未被技能引用"}
                </div>
              </div>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setRevealed((r) => ({ ...r, [e.key]: !r[e.key] }))}
              >
                {revealed[e.key] ? "隐藏" : "已保存"}
              </button>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={async () => {
                  if (window.confirm(`删除凭证 ${e.key}？`)) {
                    await deleteCredential(e.key);
                    await reload();
                  }
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
