import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { deleteCredentialValue, upsertCredentialValue } from "../../lib/skills";
import { DialogShell } from "../../components/ui/dialog-shell";
import type { CredentialRow } from "./model";

/**
 * 填写凭证值：值不回显，已保存的键标记「已保存」且留空保持不变（后端合并
 * 语义，只提交本次输入的非空键）；git PAT 键带服务端下发的 label 说明。
 */
export function FillValuesDialog(props: {
  row: CredentialRow;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { row } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const hasExisting = !row.templateOnly;
  const dirtyCount = Object.values(values).filter((v) => v !== "").length;

  const save = async () => {
    const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    if (Object.keys(payload).length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await upsertCredentialValue(row.code, payload);
      props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeMine = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteCredentialValue(row.code);
      props.onSaved();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <DialogShell
        ariaLabel={`填写凭证 ${row.code}`}
        title="填写凭证值"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{row.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{row.code}</span>
            {row.kind === "git" ? <Badge tone="info">git · 不注入 env</Badge> : null}
          </span>
        }
        onClose={props.onClose}
        footer={
          <>
            {hasExisting ? (
              <Button
                variant="danger"
                size="sm"
                className="mr-auto"
                disabled={busy || deleteBusy}
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              >
                删除我的值
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button variant="secondary" size="sm" onClick={props.onClose} disabled={busy}>
              取消
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={busy || dirtyCount === 0}>
              {busy ? "保存中…" : dirtyCount > 0 ? `保存 ${dirtyCount} 个键` : "保存"}
            </Button>
          </>
        }
      >
        <p className="rounded-lg bg-primary-soft px-3 py-2 text-xs leading-relaxed text-primary">
          值加密存储、保存后永不再显示。已保存的键留空即保持不变，只提交你本次填写或修改的键。
        </p>
        {error ? (
          <div role="alert" className="rounded-lg bg-destructive-soft p-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {row.keySpecs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {row.orphan
              ? "该凭证的全局模板已被删除，无法继续填写；可删除我的值清理残留。"
              : "该模板未定义键名。"}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {row.keySpecs.map((spec) => {
              const saved = row.filledKeys.includes(spec.key);
              const show = visible[spec.key] ?? false;
              return (
                <div key={spec.key} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[13px] font-semibold">{spec.key}</span>
                    {saved ? <Badge tone="success">已保存</Badge> : null}
                    {spec.label ? (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {spec.label}
                      </span>
                    ) : null}
                  </div>
                  <div className="relative">
                    <Input
                      type={show ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={saved ? "留空保持不变；输入新值即覆盖" : `粘贴 ${spec.key}…`}
                      value={values[spec.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [spec.key]: e.target.value }))}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      aria-label={show ? "隐藏输入内容" : "显示输入内容"}
                      onClick={() => setVisible((s) => ({ ...s, [spec.key]: !show }))}
                      className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {show ? (
                        <EyeOff size={15} aria-hidden="true" />
                      ) : (
                        <Eye size={15} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogShell>

      <ConfirmDialog
        open={confirmDelete}
        title={`删除凭证 ${row.code}？`}
        description="仅删除你个人填写的内容，不影响全局模板与他人。"
        confirmText="删除"
        destructive
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void removeMine()}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />
    </>
  );
}
