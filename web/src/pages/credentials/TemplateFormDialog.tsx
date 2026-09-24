import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { FormField } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { RadioCard } from "../../components/ui/radio-card";
import { Textarea } from "../../components/ui/textarea";
import { getUserId } from "../../lib/auth";
import {
  type CredentialTemplateDTO,
  createCredentialTemplate,
  deleteCredentialTemplate,
  updateCredentialTemplate,
} from "../../lib/skills";
import { DialogShell } from "../../components/ui/dialog-shell";
import { CREDENTIAL_KEY_PATTERN, validateCredentialCode } from "./model";

/** git PAT 凭证固定键名（与服务端 GIT_PAT_KEY_SPECS 契约对齐，键名不可自定义） */
const GIT_PAT_KEYS = ["access_token", "user"] as const;

const MAX_KEYS = 32;

/**
 * 新建/编辑模板两用表单：mode=create 时可填 code；mode=edit 时 code 只读、
 * 另提供删除入口（引用防护 409 就地展示）。
 */
export function TemplateFormDialog(props: {
  mode: "create" | "edit";
  template?: CredentialTemplateDTO;
  onSaved: (code: string, created: boolean) => void;
  onDeleted?: (code: string) => void;
  onClose: () => void;
}) {
  const t = props.template;
  const [name, setName] = useState(t?.name ?? "");
  const [code, setCode] = useState(t?.code ?? "");
  const [kind, setKind] = useState<"generic" | "git">(t?.kind ?? "generic");
  const [repoUrl, setRepoUrl] = useState(t?.repoUrl ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [keys, setKeys] = useState<string[]>(t ? t.keySpecs.map((k) => k.key) : []);
  const [keyInput, setKeyInput] = useState("");
  const [keysError, setKeysError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const addKey = (raw: string) => {
    const key = raw.trim().replace(/[,，]/g, "");
    if (!key) return true;
    if (!CREDENTIAL_KEY_PATTERN.test(key)) {
      setKeysError("键名仅允许字母、数字、下划线（1-64 位）");
      return false;
    }
    if (keys.includes(key)) {
      setKeysError(`键名 ${key} 已存在`);
      return false;
    }
    if (keys.length >= MAX_KEYS) {
      setKeysError(`最多 ${MAX_KEYS} 个键`);
      return false;
    }
    setKeysError(null);
    setKeys((ks) => [...ks, key]);
    return true;
  };

  const submit = async () => {
    const codeErr = props.mode === "create" ? validateCredentialCode(code.trim()) : null;
    setCodeError(codeErr);
    if (codeErr) return;
    if (!name.trim()) {
      setError("请填写名称");
      return;
    }
    if (kind === "generic" && keys.length === 0) {
      setKeysError("至少添加一个键名");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: code.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        kind,
        repoUrl: kind === "git" && repoUrl.trim() ? repoUrl.trim() : undefined,
        keySpecs:
          kind === "git" ? [...GIT_PAT_KEYS].map((key) => ({ key })) : keys.map((key) => ({ key })),
      };
      if (props.mode === "create") {
        await createCredentialTemplate(payload);
        props.onSaved(payload.code, true);
      } else if (t) {
        await updateCredentialTemplate(t.code, payload);
        props.onSaved(payload.code, false);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async () => {
    if (!t) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteCredentialTemplate(t.code);
      props.onDeleted?.(t.code);
    } catch (e) {
      // 引用防护 409 等错误留在确认弹窗里展示
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const isCreate = props.mode === "create";
  const keyNames = kind === "git" ? [...GIT_PAT_KEYS] : keys;

  return (
    <>
      <DialogShell
        ariaLabel={isCreate ? "新建凭证" : `编辑模板 ${t?.code ?? ""}`}
        title={isCreate ? "新建凭证" : "编辑模板"}
        subtitle={
          isCreate ? (
            "先定义凭证结构（全局模板），创建后立即填入你自己的私密值"
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{t?.code}</span>
              {t && t.createdBy === getUserId() ? <Badge tone="neutral">由你创建</Badge> : null}
            </span>
          )
        }
        onClose={props.onClose}
        footer={
          <>
            {!isCreate && t ? (
              <Button
                variant="danger"
                size="sm"
                className="mr-auto"
                disabled={busy}
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              >
                删除模板
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button variant="secondary" size="sm" onClick={props.onClose} disabled={busy}>
              取消
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={busy}>
              {busy ? "保存中…" : isCreate ? "创建并填写值" : "保存"}
            </Button>
          </>
        }
      >
        {error ? (
          <div role="alert" className="rounded-lg bg-destructive-soft p-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <FormField label="用途" hint="决定凭证如何被智能体使用">
          <div className="grid grid-cols-2 gap-2.5">
            <RadioCard
              name="credential-kind"
              value="generic"
              checked={kind === "generic"}
              onChange={() => setKind("generic")}
              title="通用"
              description="键值注入环境变量，智能体进程可读取"
            />
            <RadioCard
              name="credential-kind"
              value="git"
              checked={kind === "git"}
              onChange={() => setKind("git")}
              title="git PAT"
              description="git 工具专用，不注入环境变量"
            />
          </div>
        </FormField>

        <FormField label="名称" required>
          <Input
            placeholder="如：极狐 GitLab PAT"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>

        <FormField
          label="凭证 code"
          required
          hint={
            isCreate ? (
              <>
                小写字母/数字开头，可含 -、_；创建后不可修改，用作环境变量前缀（
                <code className="font-mono">&lt;code&gt;_&lt;key&gt;</code>）
              </>
            ) : (
              "code 创建后不可修改"
            )
          }
        >
          {isCreate ? (
            <Input
              mono
              placeholder="如：jihulab-pat"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (codeError) setCodeError(null);
              }}
            />
          ) : (
            <Input mono value={t?.code ?? ""} disabled />
          )}
          {codeError ? <p className="text-[11px] text-destructive">{codeError}</p> : null}
        </FormField>

        {kind === "git" ? (
          <FormField
            label="仓库地址"
            hint="HTTPS 地址且不含用户名密码；留空表示平台级凭证。一凭一仓，绑定后仅用于该仓库"
          >
            <Input
              mono
              placeholder="如：https://jihulab.com/your-org/x.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </FormField>
        ) : null}

        <FormField
          label="键名"
          required={kind === "generic"}
          hint={
            kind === "git"
              ? "git PAT 键名固定：access_token（访问令牌）、user（用户名，可留空），不可自定义"
              : `注入时的环境变量后缀，1-${MAX_KEYS} 个；回车或逗号添加`
          }
        >
          {kind === "git" ? (
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
              {keyNames.map((k) => (
                <span
                  key={k}
                  className="rounded-md bg-card px-1.5 py-0.5 font-mono text-xs text-foreground ring-1 ring-border"
                >
                  {k}
                </span>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 focus-within:border-primary">
              {keys.map((k) => (
                <span
                  key={k}
                  className="flex items-center gap-1 rounded-md bg-primary-soft px-1.5 py-0.5 font-mono text-xs text-primary"
                >
                  {k}
                  <button
                    type="button"
                    aria-label={`移除键名 ${k}`}
                    className="text-primary/60 hover:text-primary"
                    onClick={() => {
                      setKeys((ks) => ks.filter((x) => x !== k));
                      setKeysError(null);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="min-w-[140px] flex-1 border-0 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground/70"
                placeholder={keys.length === 0 ? "如：api_key，回车添加" : "继续添加…"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === "，") {
                    e.preventDefault();
                    if (addKey(keyInput)) setKeyInput("");
                  } else if (e.key === "Backspace" && !keyInput && keys.length > 0) {
                    setKeys((ks) => ks.slice(0, -1));
                    setKeysError(null);
                  }
                }}
                onBlur={() => {
                  if (addKey(keyInput)) setKeyInput("");
                }}
              />
            </div>
          )}
          {keysError ? <p className="text-[11px] text-destructive">{keysError}</p> : null}
        </FormField>

        <FormField label="说明" hint="用途、获取方式等，列表中展示（可选）">
          <Textarea
            rows={2}
            placeholder="如：在 GitLab → 设置 → 访问令牌 生成，需 api 权限"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
      </DialogShell>

      <ConfirmDialog
        open={confirmDelete}
        title={`删除模板 ${t?.code ?? ""}`}
        description="将删除模板结构本身；已被用户凭证引用时会被拒绝，引用它的智能体将不再注入该凭证。"
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
    </>
  );
}
