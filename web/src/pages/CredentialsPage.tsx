import { useCallback, useEffect, useState } from "react";
import {
  type CredentialTemplateDTO,
  type CredentialValueViewDTO,
  createCredentialTemplate,
  deleteCredentialValue,
  fetchCredentialTemplates,
  fetchMyCredentials,
  upsertCredentialValue,
} from "../lib/skills";

/** 新建/填写表单状态：code → 模板存在则只填值，否则先注册模板（键名逗号分隔） */
interface Draft {
  code: string;
  name: string;
  description: string;
  kind: "generic" | "git";
  keysText: string;
  values: Record<string, string>;
}

const emptyDraft: Draft = {
  code: "",
  name: "",
  description: "",
  kind: "generic",
  keysText: "",
  values: {},
};

export function CredentialsPage() {
  const [mine, setMine] = useState<CredentialValueViewDTO[]>([]);
  const [templates, setTemplates] = useState<CredentialTemplateDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [draftExists, setDraftExists] = useState(false);
  const [query, setQuery] = useState("");

  const reload = useCallback(async () => {
    try {
      setMine(await fetchMyCredentials());
      setTemplates(await fetchCredentialTemplates());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 输入 code 时探测模板：已存在 → 带出结构只填值；否则需填键名（新模板） */
  const pickCode = async (code: string) => {
    setDraft((d) => ({ ...d, code, values: {} }));
    const trimmed = code.trim();
    if (!trimmed) {
      setDraftExists(false);
      return;
    }
    try {
      const list = await fetchCredentialTemplates(trimmed);
      const hit = list.find((t) => t.code === trimmed);
      if (hit) {
        setDraft((d) => ({
          ...d,
          name: d.name || hit.name,
          description: d.description || hit.description || "",
          kind: hit.kind ?? "generic",
          keysText: hit.keySpecs.map((k) => k.key).join(","),
          values: {},
        }));
        setDraftExists(true);
      } else {
        setDraftExists(false);
      }
    } catch {
      setDraftExists(false);
    }
  };

  const keyNames = draft.keysText
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const save = async () => {
    if (!draft.code.trim() || !draft.name.trim() || keyNames.length === 0) return;
    setBusy(true);
    try {
      if (!draftExists) {
        await createCredentialTemplate({
          code: draft.code.trim(),
          name: draft.name.trim(),
          description: draft.description.trim() || undefined,
          kind: draft.kind,
          keySpecs: keyNames.map((key) => ({ key })),
        });
      }
      const values = Object.fromEntries(
        keyNames.map((k) => [k, draft.values[k] ?? ""] as const).filter(([, v]) => v !== ""),
      );
      if (Object.keys(values).length > 0) {
        await upsertCredentialValue(draft.code.trim(), values);
      }
      setDraft(emptyDraft);
      setDraftExists(false);
      await reload();
      setError(null);
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
        凭证是个人数据，仅本人可见与使用；值加密存储且永不再显示。共享智能体执行时使用的是
        <span className="font-medium">你自己的</span>同名凭证。
      </p>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mb-4 rounded-lg border border-border p-3">
        <div className="mb-2 text-sm font-medium">新增 / 填写凭证</div>
        <div className="mb-2 flex flex-wrap gap-2">
          <input
            className="w-48 rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="code（如 jihulab-pat）"
            value={draft.code}
            onChange={(e) => void pickCode(e.target.value)}
          />
          <input
            className="w-48 rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="名称"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          {draftExists ? null : (
            <select
              className="rounded-md border border-border px-2 py-1.5 text-sm"
              value={draft.kind}
              onChange={(e) =>
                setDraft((d) => ({ ...d, kind: e.target.value as "generic" | "git" }))
              }
            >
              <option value="generic">通用（注入环境变量）</option>
              <option value="git">git PAT（工具专用，不注入环境变量）</option>
            </select>
          )}
          {draftExists ? null : (
            <input
              className="w-56 rounded-md border border-border px-2 py-1.5 text-sm"
              placeholder="键名（逗号分隔，如: token,region）"
              value={draft.keysText}
              onChange={(e) => setDraft((d) => ({ ...d, keysText: e.target.value }))}
            />
          )}
          <input
            className="w-64 rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="说明（可选）"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </div>
        {keyNames.length > 0 && (
          <div className="mb-2 grid gap-2 md:grid-cols-2">
            {keyNames.map((k) => (
              <input
                key={k}
                type="password"
                className="rounded-md border border-border px-2 py-1.5 text-sm"
                placeholder={`值：${k}（不可见保存）`}
                value={draft.values[k] ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, values: { ...d.values, [k]: e.target.value } }))
                }
              />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy || !draft.code.trim() || !draft.name.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            保存
          </button>
          {draftExists && (
            <span className="text-xs text-muted-foreground">
              模板已存在：保留结构，仅更新你填写的值
            </span>
          )}
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium">我的凭证</div>
        <input
          className="w-48 rounded-md border border-border px-2 py-1 text-xs"
          placeholder="搜索全局模板…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {mine.length === 0 ? (
        <div className="mb-4 text-sm text-muted-foreground">暂无凭证。</div>
      ) : (
        <div className="mb-4 space-y-2">
          {mine.map((c) => (
            <div key={c.code} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{c.code}</span>
                <span className="text-sm">{c.name}</span>
                {c.missingKeys.length > 0 && (
                  <span className="text-xs text-amber-600">缺填: {c.missingKeys.join(", ")}</span>
                )}
              </div>
              {c.description && (
                <div className="text-xs text-muted-foreground">{c.description}</div>
              )}
              <div className="text-xs text-muted-foreground">
                已填键：{c.filledKeys.length > 0 ? c.filledKeys.join(", ") : "（无）"}
              </div>
              <button
                type="button"
                className="mt-1 text-xs text-muted-foreground hover:text-destructive"
                onClick={async () => {
                  if (window.confirm(`删除凭证 ${c.code}？（不影响全局模板与他人）`)) {
                    await deleteCredentialValue(c.code);
                    await reload();
                  }
                }}
              >
                删除我的凭证
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="text-sm font-medium">全局模板（选用后只需填值）</div>
      <div className="mt-2 space-y-1">
        {templates
          .filter(
            (t) =>
              !query ||
              t.code.includes(query.toLowerCase()) ||
              t.name.includes(query) ||
              (t.description ?? "").includes(query),
          )
          .map((t) => (
            <div key={t.code} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{t.code}</span>
              <span>{t.name}</span>
              <span>keys=[{t.keySpecs.map((k) => k.key).join(",")}]</span>
              {t.kind === "git" ? (
                <span className="rounded bg-blue-500/10 px-1 text-blue-600">git·不注入env</span>
              ) : null}
              <button
                type="button"
                className="text-foreground hover:underline"
                onClick={() => void pickCode(t.code)}
              >
                选用
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}
