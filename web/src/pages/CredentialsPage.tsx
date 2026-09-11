import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
import { getUserId } from "../lib/auth";
import {
  type CredentialTemplateDTO,
  type CredentialValueViewDTO,
  createCredentialTemplate,
  deleteCredentialTemplate,
  deleteCredentialValue,
  fetchCredentialTemplates,
  fetchMyCredentials,
  renameCredentialValue,
  updateCredentialTemplate,
  upsertCredentialValue,
} from "../lib/skills";

/** 新建/填写表单状态：code → 模板存在则只填值，否则先注册模板（键名逗号分隔） */
interface Draft {
  code: string;
  name: string;
  description: string;
  kind: "generic" | "git";
  repoUrl: string;
  keysText: string;
  values: Record<string, string>;
}

const emptyDraft: Draft = {
  code: "",
  name: "",
  description: "",
  kind: "generic",
  repoUrl: "",
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
  const [mineQuery, setMineQuery] = useState("");
  const [tplQuery, setTplQuery] = useState("");
  // 模板编辑弹窗（仅创建人可见入口）+ 删除二级确认
  const [editing, setEditing] = useState<CredentialTemplateDTO | null>(null);
  const [editForm, setEditForm] = useState<TemplateEditForm>(emptyEditForm);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 我的凭证行内改名（个人别名；只改名称不触碰加密 values）
  const [renamingCode, setRenamingCode] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const myId = getUserId();

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
          repoUrl: d.repoUrl || hit.repoUrl || "",
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
          repoUrl: draft.kind === "git" && draft.repoUrl.trim() ? draft.repoUrl.trim() : undefined,
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

  const openEdit = (t: CredentialTemplateDTO) => {
    setEditing(t);
    setEditForm({
      name: t.name,
      description: t.description ?? "",
      kind: t.kind ?? "generic",
      repoUrl: t.repoUrl ?? "",
      keysText: t.keySpecs.map((k) => k.key).join(","),
    });
    setEditError(null);
    setDeleteError(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editForm.name.trim()) {
      setEditError("名称必填");
      return;
    }
    const keys = editForm.keysText
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length === 0) {
      setEditError("至少保留一个键名");
      return;
    }
    setEditBusy(true);
    try {
      await updateCredentialTemplate(editing.code, {
        name: editForm.name.trim(),
        description: editForm.description.trim() || undefined,
        kind: editForm.kind,
        repoUrl:
          editForm.kind === "git" && editForm.repoUrl.trim() ? editForm.repoUrl.trim() : undefined,
        keySpecs: keys.map((key) => ({ key })),
      });
      setEditing(null);
      await reload();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  };

  const removeTemplate = async () => {
    if (!editing) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteCredentialTemplate(editing.code);
      setConfirmDelete(false);
      setEditing(null);
      await reload();
    } catch (e) {
      // 引用防护 409 等错误留在确认弹窗里展示
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const saveRename = async (code: string) => {
    const name = renameText.trim();
    if (!name) {
      setRenameError("名称不能为空");
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await renameCredentialValue(code, name);
      setRenamingCode(null);
      await reload();
    } catch (e) {
      setRenameError((e as Error).message);
    } finally {
      setRenameBusy(false);
    }
  };

  const mineFiltered = mine.filter(
    (c) =>
      !mineQuery ||
      c.code.includes(mineQuery.toLowerCase()) ||
      c.name.includes(mineQuery) ||
      (c.description ?? "").includes(mineQuery),
  );

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-7">
      <PageHeader
        className="mb-4"
        title="凭证"
        description="个人凭证管理，值加密存储且永不再显示"
      />
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
          placeholder="搜索我的凭证…"
          value={mineQuery}
          onChange={(e) => setMineQuery(e.target.value)}
        />
      </div>

      {mine.length === 0 ? (
        <div className="mb-4 text-sm text-muted-foreground">暂无凭证。</div>
      ) : mineFiltered.length === 0 ? (
        <div className="mb-4 text-sm text-muted-foreground">无匹配凭证。</div>
      ) : (
        <div className="mb-4 space-y-2">
          {mineFiltered.map((c) => (
            <div key={c.code} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{c.code}</span>
                {renamingCode === c.code ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <input
                      className="w-56 rounded-md border border-border px-2 py-1 text-sm"
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(c.code);
                        if (e.key === "Escape") setRenamingCode(null);
                      }}
                    />
                    <button
                      type="button"
                      className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      disabled={renameBusy}
                      onClick={() => void saveRename(c.code)}
                    >
                      {renameBusy ? "保存中…" : "保存"}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted hover:bg-accent"
                      onClick={() => {
                        setRenamingCode(null);
                        setRenameError(null);
                      }}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="text-sm">{c.name}</span>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setRenamingCode(c.code);
                        setRenameText(c.alias ?? c.name);
                        setRenameError(null);
                      }}
                    >
                      改名
                    </button>
                  </>
                )}
                {c.missingKeys.length > 0 && (
                  <span className="text-xs text-amber-600">缺填: {c.missingKeys.join(", ")}</span>
                )}
              </div>
              {renamingCode === c.code && renameError ? (
                <div className="mt-1 text-xs text-destructive">{renameError}</div>
              ) : null}
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

      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">全局模板（选用后只需填值）</div>
        <input
          className="w-48 rounded-md border border-border px-2 py-1 text-xs"
          placeholder="搜索模板…"
          value={tplQuery}
          onChange={(e) => setTplQuery(e.target.value)}
        />
      </div>
      <div className="mt-2 space-y-1">
        {templates
          .filter(
            (t) =>
              !tplQuery ||
              t.code.includes(tplQuery.toLowerCase()) ||
              t.name.includes(tplQuery) ||
              (t.description ?? "").includes(tplQuery),
          )
          .map((t) => (
            <div key={t.code} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{t.code}</span>
              <span>{t.name}</span>
              <span>keys=[{t.keySpecs.map((k) => k.key).join(",")}]</span>
              {t.kind === "git" ? (
                <span className="rounded bg-blue-500/10 px-1 text-blue-600">git·不注入env</span>
              ) : null}
              {t.repoUrl ? <span className="font-mono text-xs">{t.repoUrl}</span> : null}
              {t.createdBy === myId ? (
                <button
                  type="button"
                  className="text-foreground hover:underline"
                  onClick={() => openEdit(t)}
                >
                  编辑
                </button>
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

      {editing && (
        <TemplateEditDialog
          template={editing}
          form={editForm}
          busy={editBusy}
          error={editError}
          onFormChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))}
          onSave={() => void saveEdit()}
          onCancel={() => setEditing(null)}
          onDelete={() => {
            setDeleteError(null);
            setConfirmDelete(true);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={`删除模板 ${editing?.code ?? ""}`}
        description="将删除模板结构本身；已被用户凭证引用时会被拒绝。引用它的智能体将不再注入该凭证。"
        confirmText="删除"
        destructive
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void removeTemplate()}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

/** 模板编辑表单（code 不可改，仅展示） */
interface TemplateEditForm {
  name: string;
  description: string;
  kind: "generic" | "git";
  repoUrl: string;
  keysText: string;
}

const emptyEditForm: TemplateEditForm = {
  name: "",
  description: "",
  kind: "generic",
  repoUrl: "",
  keysText: "",
};

/** 模板编辑弹窗：创建人可改结构（名称/说明/用途/仓库/键名）；删除走二级确认 */
function TemplateEditDialog(props: {
  template: CredentialTemplateDTO;
  form: TemplateEditForm;
  busy: boolean;
  error: string | null;
  onFormChange: (patch: Partial<TemplateEditForm>) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onCancel]);

  const { template, form, busy, error, onFormChange, onSave, onCancel, onDelete } = props;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={`编辑模板 ${template.code}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-lg border bg-card p-5 shadow-lg">
        <h2 className="text-base font-semibold">
          编辑模板 <span className="font-mono text-sm">{template.code}</span>
        </h2>
        {error ? (
          <div className="mt-3 rounded bg-destructive-soft p-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div className="mt-3 space-y-2">
          <input
            className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="名称"
            value={form.name}
            onChange={(e) => onFormChange({ name: e.target.value })}
          />
          <input
            className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="说明（可选）"
            value={form.description}
            onChange={(e) => onFormChange({ description: e.target.value })}
          />
          <div className="flex gap-2">
            <select
              className="rounded-md border border-border px-2 py-1.5 text-sm"
              value={form.kind}
              onChange={(e) => onFormChange({ kind: e.target.value as "generic" | "git" })}
            >
              <option value="generic">通用（注入环境变量）</option>
              <option value="git">git PAT（工具专用，不注入环境变量）</option>
            </select>
            {form.kind === "git" ? (
              <input
                className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm"
                placeholder="仓库地址（HTTPS，一凭一仓）"
                value={form.repoUrl}
                onChange={(e) => onFormChange({ repoUrl: e.target.value })}
              />
            ) : null}
          </div>
          <input
            className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="键名（逗号分隔，如: token,region）"
            value={form.keysText}
            onChange={(e) => onFormChange({ keysText: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            code 不可修改。删除键名后，用户已填的对应值不再注入；改为 git
            用途后该凭证不再注入环境变量。
          </p>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-destructive hover:bg-destructive-soft"
            onClick={onDelete}
          >
            删除
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm hover:bg-accent"
              onClick={onCancel}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={busy || !form.name.trim()}
              onClick={onSave}
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
