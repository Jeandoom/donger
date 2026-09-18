import { Check, KeyRound, Pencil, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { PageHeader } from "../../components/ui/page-header";
import { Segmented } from "../../components/ui/segmented";
import { getUserId } from "../../lib/auth";
import {
  type CredentialTemplateDTO,
  deleteCredentialValue,
  fetchCredentialTemplates,
  fetchMyCredentials,
  renameCredentialValue,
} from "../../lib/skills";
import { FillValuesDialog } from "./FillValuesDialog";
import {
  type CredentialFilter,
  type CredentialRow,
  filterCredentialRows,
  mergeCredentialRows,
} from "./model";
import { TemplateFormDialog } from "./TemplateFormDialog";

export function CredentialsPage() {
  const [mine, setMine] = useState<CredentialRow[]>([]);
  const [templates, setTemplates] = useState<CredentialTemplateDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CredentialFilter>("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [editTemplate, setEditTemplate] = useState<CredentialTemplateDTO | null>(null);
  const [fillCode, setFillCode] = useState<string | null>(null);
  const [pendingValueDelete, setPendingValueDelete] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const myId = getUserId();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [mineList, tplList] = await Promise.all([
        fetchMyCredentials(),
        fetchCredentialTemplates(),
      ]);
      setMine(mineList);
      setTemplates(tplList);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 操作成功提示：3s 自动消退
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(timer);
  }, [flash]);

  const rows = useMemo(() => mergeCredentialRows(mine, templates), [mine, templates]);

  // 深链 /settings/credentials?fill=<code>：打开对应凭证的填写弹窗（聊天缺失卡跳转入口）
  const fillParam = searchParams.get("fill");
  useEffect(() => {
    if (!fillParam || loading) return;
    if (rows.some((r) => r.code === fillParam)) setFillCode(fillParam);
    setSearchParams({}, { replace: true });
  }, [fillParam, loading, rows, setSearchParams]);

  const filtered = useMemo(() => filterCredentialRows(rows, filter, query), [rows, filter, query]);
  const todoCount = rows.filter((r) => r.missingKeys.length > 0).length;
  const fillRow = rows.find((r) => r.code === fillCode) ?? null;

  const showFlash = (msg: string) => setFlash(msg);

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-7">
      <PageHeader
        title="凭证"
        description="个人凭证，值加密存储、永不再显示；共享智能体执行时使用的是你自己的同名凭证。"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={15} aria-hidden="true" className="mr-1" />
            新建凭证
          </Button>
        }
      />

      {flash ? (
        <div
          role="status"
          className="mt-4 flex items-center gap-1.5 rounded-lg bg-success-soft px-3 py-2 text-sm text-success"
        >
          <Check size={14} aria-hidden="true" />
          {flash}
        </div>
      ) : null}

      {loadError ? (
        <div className="mt-4 flex items-center justify-between rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          <span>加载失败：{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            重试
          </Button>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <div className="relative w-72">
              <Search
                size={14}
                aria-hidden="true"
                className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="pl-8"
                placeholder="搜索名称或 code…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Segmented<CredentialFilter>
              name="凭证状态筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `全部 ${rows.length}` },
                { value: "todo", label: `待补全 ${todoCount}` },
                { value: "ready", label: `已配置 ${rows.length - todoCount}` },
              ]}
            />
          </div>

          <div className="mt-3 flex flex-col gap-2.5">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">无匹配凭证。</p>
            ) : (
              filtered.map((row) => (
                <CredentialRowCard
                  key={row.code}
                  row={row}
                  canEditTemplate={row.createdBy === myId}
                  onFill={() => setFillCode(row.code)}
                  onEditTemplate={() =>
                    setEditTemplate(templates.find((t) => t.code === row.code) ?? null)
                  }
                  onDeleteValue={() => {
                    setDeleteError(null);
                    setPendingValueDelete(row.code);
                  }}
                  onRenamed={() => void reload()}
                />
              ))
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            待补全的凭证排在最前。全局模板由全体成员共享，仅创建人可修改结构；值只属于你自己。
          </p>
        </>
      ) : (
        <Card className="mt-8 flex flex-col items-center gap-3 p-10">
          <KeyRound size={28} aria-hidden="true" className="text-muted-foreground" />
          <div className="text-sm font-semibold">还没有凭证</div>
          <p className="max-w-sm text-center text-[13px] text-muted-foreground">
            凭证让智能体以你的身份访问外部平台。从全局模板选用，或新建一个凭证结构并填入你的私密值。
          </p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={15} aria-hidden="true" className="mr-1" />
            新建凭证
          </Button>
        </Card>
      )}

      {loading && rows.length === 0 && !loadError ? (
        <p className="mt-4 text-sm text-muted-foreground">加载中…</p>
      ) : null}

      {createOpen ? (
        <TemplateFormDialog
          mode="create"
          onClose={() => setCreateOpen(false)}
          onSaved={(code) => {
            setCreateOpen(false);
            setFillCode(code);
            showFlash("凭证已创建，请填写你的值");
            void reload();
          }}
        />
      ) : null}

      {editTemplate ? (
        <TemplateFormDialog
          mode="edit"
          template={editTemplate}
          onClose={() => setEditTemplate(null)}
          onSaved={() => {
            setEditTemplate(null);
            showFlash("模板已更新");
            void reload();
          }}
          onDeleted={() => {
            setEditTemplate(null);
            showFlash("模板已删除");
            void reload();
          }}
        />
      ) : null}

      {fillRow ? (
        <FillValuesDialog
          row={fillRow}
          onClose={() => setFillCode(null)}
          onSaved={() => {
            setFillCode(null);
            showFlash("凭证值已保存");
            void reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingValueDelete !== null}
        title={`删除凭证 ${pendingValueDelete ?? ""}？`}
        description="仅删除你个人填写的内容，不影响全局模板与他人。"
        confirmText="删除"
        destructive
        busy={deleteBusy}
        error={deleteError}
        onConfirm={async () => {
          if (!pendingValueDelete) return;
          setDeleteBusy(true);
          try {
            await deleteCredentialValue(pendingValueDelete);
            setPendingValueDelete(null);
            showFlash("我的凭证值已删除");
            await reload();
          } catch (e) {
            setDeleteError(e instanceof Error ? e.message : String(e));
          } finally {
            setDeleteBusy(false);
          }
        }}
        onCancel={() => {
          setPendingValueDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

/** 列表行卡片：状态点 + 名称/键芯片 + 行内动作（填写/重命名/编辑模板/删除） */
function CredentialRowCard(props: {
  row: CredentialRow;
  canEditTemplate: boolean;
  onFill: () => void;
  onEditTemplate: () => void;
  onDeleteValue: () => void;
  onRenamed: () => void;
}) {
  const { row } = props;
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const state = row.orphan
    ? "error"
    : row.missingKeys.length === 0
      ? "ready"
      : row.templateOnly
        ? "none"
        : "partial";

  const saveRename = async () => {
    const name = renameText.trim();
    if (!name) {
      setRenameError("名称不能为空");
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await renameCredentialValue(row.code, name);
      setRenaming(false);
      props.onRenamed();
    } catch (e) {
      setRenameError((e as Error).message);
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <Card className="flex items-start gap-3 p-4">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          state === "ready"
            ? "bg-success"
            : state === "partial"
              ? "bg-warning"
              : state === "error"
                ? "bg-destructive"
                : "bg-muted-foreground/40"
        }`}
      />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              className="h-8 w-56 text-sm"
              value={renameText}
              aria-label={`重命名 ${row.code}`}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveRename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
            <Button size="sm" disabled={renameBusy} onClick={() => void saveRename()}>
              {renameBusy ? "保存中…" : "保存"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRenaming(false);
                setRenameError(null);
              }}
            >
              取消
            </Button>
            {renameError ? (
              <span role="alert" className="text-xs text-destructive">
                {renameError}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{row.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{row.code}</span>
            {row.alias ? <Badge tone="neutral">别名</Badge> : null}
            {row.kind === "git" ? <Badge tone="info">git · 不注入 env</Badge> : null}
            {row.orphan ? <Badge tone="danger">模板已删除</Badge> : null}
            {row.templateOnly ? <Badge tone="warning">未配置</Badge> : null}
            <button
              type="button"
              aria-label={`重命名 ${row.code}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setRenameText(row.alias ?? row.name);
                setRenameError(null);
                setRenaming(true);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
          </div>
        )}
        {row.description ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{row.description}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {row.keySpecs.map((spec) => {
            const filled = row.filledKeys.includes(spec.key);
            return (
              <span
                key={spec.key}
                title={spec.label}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
                  filled ? "bg-success-soft text-success" : "bg-warning-soft text-amber-700"
                }`}
              >
                {filled ? <Check size={10} aria-hidden="true" /> : null}
                {spec.key}
              </span>
            );
          })}
          {row.orphan ? (
            <span className="text-[11px] text-muted-foreground">
              已填 {row.filledKeys.length} 个键（结构未知）
            </span>
          ) : null}
          {row.missingKeys.length > 0 ? (
            <span className="text-[11px] font-medium text-amber-700">
              缺 {row.missingKeys.length} 键
            </span>
          ) : null}
          {row.repoUrl ? (
            <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground">
              {row.repoUrl}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={props.onFill}>
          {row.templateOnly ? "去填写" : "填写"}
        </Button>
        {props.canEditTemplate ? (
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={props.onEditTemplate}
          >
            编辑模板
          </button>
        ) : null}
        {!row.templateOnly ? (
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
            onClick={props.onDeleteValue}
          >
            删除我的值
          </button>
        ) : null}
      </div>
    </Card>
  );
}
