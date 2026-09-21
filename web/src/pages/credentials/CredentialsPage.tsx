import {
  Check,
  GitBranch,
  KeyRound,
  LayoutTemplate,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { Menu, type MenuEntry } from "../../components/ui/menu";
import { PageHeader } from "../../components/ui/page-header";
import { Segmented } from "../../components/ui/segmented";
import { getUserId } from "../../lib/auth";
import {
  type CredentialTemplateDTO,
  type CredentialValueViewDTO,
  deleteCredentialTemplate,
  deleteCredentialValue,
  fetchCredentialTemplates,
  fetchMyCredentials,
  renameCredentialValue,
} from "../../lib/skills";
import { cn } from "../../lib/utils";
import { FillValuesDialog } from "./FillValuesDialog";
import {
  type CredentialFilter,
  type CredentialRow,
  filterCredentialRows,
  formatRelativeTime,
  mergeCredentialRows,
  splitCredentialSections,
} from "./model";
import { TemplateFormDialog } from "./TemplateFormDialog";

export function CredentialsPage() {
  const [mine, setMine] = useState<CredentialValueViewDTO[]>([]);
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
  const [pendingTemplateDelete, setPendingTemplateDelete] = useState<string | null>(null);
  const [tplDeleteBusy, setTplDeleteBusy] = useState(false);
  const [tplDeleteError, setTplDeleteError] = useState<string | null>(null);
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
  const sections = useMemo(() => splitCredentialSections(rows), [rows]);

  // 深链 /credentials?fill=<code>：打开对应凭证的填写弹窗（聊天缺失卡跳转入口）
  const fillParam = searchParams.get("fill");
  useEffect(() => {
    if (!fillParam || loading) return;
    if (rows.some((r) => r.code === fillParam)) setFillCode(fillParam);
    setSearchParams({}, { replace: true });
  }, [fillParam, loading, rows, setSearchParams]);

  // 分段计数只统计「我的凭证」；待补全时可用模板区恒显（它天然是待办），已配置时隐藏
  const todoCount = sections.mine.filter((r) => r.missingKeys.length > 0).length;
  const filteredMine = useMemo(
    () => filterCredentialRows(sections.mine, filter, query),
    [sections.mine, filter, query],
  );
  const filteredTemplates = useMemo(
    () => (filter === "ready" ? [] : filterCredentialRows(sections.templates, "all", query)),
    [sections.templates, filter, query],
  );
  const fillRow = rows.find((r) => r.code === fillCode) ?? null;

  const showFlash = (msg: string) => setFlash(msg);

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-7">
      <PageHeader
        title="凭证"
        description="值加密存储、永不再显示；共享智能体执行时使用你自己配置的凭证。"
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
                { value: "all", label: `全部 ${sections.mine.length}` },
                { value: "todo", label: `待补全 ${todoCount}` },
                { value: "ready", label: `已配置 ${sections.mine.length - todoCount}` },
              ]}
            />
          </div>

          <div className="mt-5 flex flex-col gap-6">
            <section className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold">我的凭证</h2>
                <Badge>{sections.mine.length}</Badge>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  值只属于你自己，共享智能体运行时注入
                </span>
              </div>
              {filteredMine.length === 0 ? (
                sections.mine.length === 0 && sections.templates.length > 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                    还没有属于你的凭证——从下方可用模板开始，填写后即成为你的凭证。
                  </p>
                ) : (
                  <p className="py-4 text-center text-sm text-muted-foreground">无匹配凭证。</p>
                )
              ) : (
                filteredMine.map((row) => (
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
            </section>

            {filteredTemplates.length > 0 ? (
              <section className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <h2 className="text-[13px] font-semibold">可用模板</h2>
                  <Badge>{filteredTemplates.length}</Badge>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    平台共享的凭证结构，填写后即成为你的凭证
                  </span>
                </div>
                {filteredTemplates.map((row) => (
                  <TemplateRowCard
                    key={row.code}
                    row={row}
                    canEditTemplate={row.createdBy === myId}
                    onFill={() => setFillCode(row.code)}
                    onEditTemplate={() =>
                      setEditTemplate(templates.find((t) => t.code === row.code) ?? null)
                    }
                    onDeleteTemplate={() => {
                      setTplDeleteError(null);
                      setPendingTemplateDelete(row.code);
                    }}
                  />
                ))}
              </section>
            ) : null}
          </div>
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

      <ConfirmDialog
        open={pendingTemplateDelete !== null}
        title={`删除模板 ${pendingTemplateDelete ?? ""}？`}
        description="将删除模板结构本身；已被用户凭证引用时会被拒绝，引用它的智能体将不再注入该凭证。"
        confirmText="删除"
        destructive
        busy={tplDeleteBusy}
        error={tplDeleteError}
        onConfirm={async () => {
          if (!pendingTemplateDelete) return;
          setTplDeleteBusy(true);
          try {
            await deleteCredentialTemplate(pendingTemplateDelete);
            setPendingTemplateDelete(null);
            showFlash("模板已删除");
            await reload();
          } catch (e) {
            setTplDeleteError(e instanceof Error ? e.message : String(e));
          } finally {
            setTplDeleteBusy(false);
          }
        }}
        onCancel={() => {
          setPendingTemplateDelete(null);
          setTplDeleteError(null);
        }}
      />
    </div>
  );
}

/** 我的凭证行卡 v4：名称+单一状态徽章 / 元信息行（code·键位·说明）/ 动作收敛；窄屏转两行式 */
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

  const partial = !row.orphan && row.missingKeys.length > 0;
  const RowIcon = row.kind === "git" ? GitBranch : KeyRound;

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

  const entries: MenuEntry[] = [
    {
      kind: "item",
      label: "重命名",
      icon: <Pencil size={13} aria-hidden="true" />,
      onSelect: () => {
        setRenameText(row.alias ?? row.name);
        setRenameError(null);
        setRenaming(true);
      },
    },
  ];
  if (props.canEditTemplate) {
    entries.push({
      kind: "item",
      label: "编辑模板",
      icon: <Settings2 size={13} aria-hidden="true" />,
      onSelect: props.onEditTemplate,
    });
  }
  entries.push({ kind: "separator" });
  entries.push({
    kind: "item",
    label: "删除我的值",
    icon: <Trash2 size={13} aria-hidden="true" />,
    danger: true,
    onSelect: props.onDeleteValue,
  });

  const status = row.orphan ? (
    <Badge tone="danger" className="shrink-0">
      模板已删除
    </Badge>
  ) : partial ? (
    <Badge tone="warning" className="shrink-0">
      缺 {row.missingKeys.length} 键
    </Badge>
  ) : (
    <Badge tone="success" className="shrink-0">
      就绪
    </Badge>
  );

  return (
    <Card className="flex flex-col gap-1.5 px-3.5 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 items-center gap-2.5 sm:flex-1">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-muted">
          <RowIcon size={18} aria-hidden="true" className="text-slate-600" />
        </span>
        {renaming ? (
          <div className="min-w-0 flex-1">
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
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
              {status}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
              <span className="shrink-0 font-mono text-muted-foreground">{row.code}</span>
              {!row.orphan ? (
                <>
                  <span className="shrink-0 text-muted-foreground/50">·</span>
                  <span
                    className={cn(
                      "shrink-0",
                      partial ? "font-medium text-amber-700" : "text-muted-foreground",
                    )}
                  >
                    {row.filledKeys.length}/{row.keySpecs.length} 键
                  </span>
                </>
              ) : (
                <span className="shrink-0 text-muted-foreground">
                  已填 {row.filledKeys.length} 个键（结构未知）
                </span>
              )}
              {row.description ? (
                <span className="min-w-0 truncate text-muted-foreground/80" title={row.description}>
                  {row.description}
                </span>
              ) : null}
              {row.repoUrl ? (
                <span
                  className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground/70 sm:inline"
                  title={row.repoUrl}
                >
                  {row.repoUrl}
                </span>
              ) : null}
              <span className="ml-auto hidden shrink-0 pl-2 text-[11px] text-muted-foreground/70 sm:inline">
                {formatRelativeTime(row.updatedAt)}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 pl-[46px] sm:pl-0">
        <Button
          variant={partial ? "ghost" : "outline"}
          size="sm"
          onClick={props.onFill}
          title={partial ? `缺 ${row.missingKeys.length} 个键，点击补全` : "填写 / 查看键位"}
        >
          {partial ? "补全" : "填写"}
        </Button>
        <Menu label={`更多操作：${row.code}`} entries={entries} />
      </div>
    </Card>
  );
}

/** 可用模板行 v4：虚线弱化卡 + 名称/元信息两行 + 填写 CTA；窄屏同构两行式 */
function TemplateRowCard(props: {
  row: CredentialRow;
  canEditTemplate: boolean;
  onFill: () => void;
  onEditTemplate: () => void;
  onDeleteTemplate: () => void;
}) {
  const { row } = props;
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-dashed border-slate-300 bg-white/60 px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 items-center gap-2.5 sm:flex-1">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <LayoutTemplate size={15} aria-hidden="true" className="text-slate-600" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{row.name}</span>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]">
            <span className="shrink-0 font-mono text-muted-foreground">{row.code}</span>
            <span className="shrink-0 text-muted-foreground/50">·</span>
            <span className="shrink-0 text-muted-foreground">{row.keySpecs.length} 个键</span>
            {row.description ? (
              <span className="min-w-0 truncate text-muted-foreground/70" title={row.description}>
                {row.description}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 pl-[38px] sm:pl-0">
        <Button variant="ghost" size="sm" onClick={props.onFill}>
          填写
        </Button>
        {props.canEditTemplate ? (
          <Menu
            label={`模板操作：${row.code}`}
            entries={[
              {
                kind: "item",
                label: "编辑模板",
                icon: <Settings2 size={13} aria-hidden="true" />,
                onSelect: props.onEditTemplate,
              },
              { kind: "separator" },
              {
                kind: "item",
                label: "删除模板",
                icon: <Trash2 size={13} aria-hidden="true" />,
                danger: true,
                onSelect: props.onDeleteTemplate,
              },
            ]}
          />
        ) : null}
      </div>
    </div>
  );
}
