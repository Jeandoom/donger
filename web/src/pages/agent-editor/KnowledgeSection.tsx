import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { DialogShell } from "../../components/ui/dialog-shell";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import {
  type AgentConversationScopeDTO,
  type AgentFeedbackScopeDTO,
  fetchAgents,
} from "../../lib/agents";
import { fetchKnowledgeBases, updateKb } from "../../lib/kb";
import { cn } from "../../lib/utils";
import type { AgentEditorForm } from "./model";

/**
 * 知识库与上下文分区（specs/2026-09-29-agent-editor-ui-redesign.md §4）：三类对话中
 * 可引用的资料源收拢一区——知识库（kb_* 工具：专有库/用户库/自动学习）、历史会话
 * （% 引用）、反馈记录（# 引用）。后两者自「资源」区并入（同为引用面，语义同族）。
 *
 * 独立知识库 = 本智能体专有库单选项（2026-10-26 修订）：勾选即绑定并作为自动学习唯一
 * 可写目标；无专有库时保存时自动创建（默认名「{agent名}-知识库」，重名自动加序号，
 * 无需手填）；已有专有库经「改名」弹窗变更名称（确认时前后端双重唯一性校验，
 * 取消/关闭不生效）。其他智能体的专有库不进任何候选（sourceAgentId 归属过滤，
 * 保存端同口径硬拒、运行时不挂载）。
 */
export function KnowledgeSection(props: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  /** 本智能体 id（新建态缺省）：专有库归属判定（sourceAgentId === agentId） */
  agentId?: string;
  /** 独立知识库待建伪状态（保存时先建库回填 kbWriteTargetId；不入 agent 字段） */
  kbNew: { enabled: boolean };
  onKbNewChange: (next: { enabled: boolean }) => void;
  /** 变化时重拉候选（保存新建专有库后回填名称展示） */
  refreshKey?: number;
}) {
  const { form, patch } = props;
  const [candidates, setCandidates] = useState<
    Array<{
      id: string;
      name: string;
      role: string;
      personal: boolean;
      mine: boolean;
      sourceAgentId?: string;
    }>
  >([]);
  const [kbLoaded, setKbLoaded] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 仅用于保存建库后触发重拉
  useEffect(() => {
    fetchKnowledgeBases()
      .then((libs) => {
        setCandidates(
          libs
            .filter((l) => !l.builtin)
            .map((l) => ({
              id: l.id,
              name: l.name,
              role: l._role,
              personal: l.personal,
              mine: l._mine,
              ...(l.sourceAgentId ? { sourceAgentId: l.sourceAgentId } : {}),
            })),
        );
        setKbLoaded(true);
      })
      .catch(() => {
        setCandidates([]);
        setKbLoaded(true);
      });
  }, [props.refreshKey]);

  const toggleKb = (id: string, checked: boolean): void => {
    const current = form.knowledgeBaseIds ?? [];
    const next = checked ? [...current, id] : current.filter((x) => x !== id);
    patch({ knowledgeBaseIds: next });
  };

  // 独立知识库 = 专有库单选项：已有专有库直接复用（幂等并入绑定），否则走保存建库
  const ownKb = props.agentId
    ? candidates.find((c) => c.sourceAgentId === props.agentId)
    : undefined;
  const targetId = form.kbWriteTargetId ?? null;
  const targetKb = targetId ? candidates.find((c) => c.id === targetId) : undefined;
  const standaloneChecked = targetId != null || props.kbNew.enabled;
  const canRenameTarget =
    targetKb != null && props.agentId != null && targetKb.sourceAgentId === props.agentId;
  // 待建专有库默认名：与本人既有库重名时加序号（保存端另有 409 重试兜底）
  const takenNames = new Set(candidates.filter((c) => c.mine).map((c) => c.name));
  const pendingKbName = dedupeKbName(`${form.name || "本智能体"}-知识库`, takenNames);

  const toggleStandalone = (checked: boolean): void => {
    if (checked) {
      if (ownKb) {
        const current = form.knowledgeBaseIds ?? [];
        patch({
          kbWriteTargetId: ownKb.id,
          knowledgeBaseIds: current.includes(ownKb.id) ? current : [...current, ownKb.id],
        });
      } else {
        props.onKbNewChange({ enabled: true });
      }
      return;
    }
    // 取消：清可写目标；专有库随勾选态从绑定一并摘除（它的唯一绑定入口就是本选项）。
    // 旧版独立库（指向普通库）保持既有语义：仅清目标，绑定保留
    props.onKbNewChange({ enabled: false });
    const wasOwn = targetId != null && targetId === ownKb?.id;
    patch({
      kbWriteTargetId: null,
      ...(wasOwn
        ? { knowledgeBaseIds: (form.knowledgeBaseIds ?? []).filter((x) => x !== targetId) }
        : {}),
    });
  };

  const openRename = (): void => {
    if (!targetKb) return;
    setRenameDraft(targetKb.name);
    setRenameError(null);
    setRenameOpen(true);
  };

  /** 改名确认：先本地查重（本人库内唯一），后端 PATCH 再兜 UNIQUE 409；取消/关闭不发起请求 */
  const submitRename = async (): Promise<void> => {
    if (!targetKb) return;
    const next = renameDraft.trim();
    if (!next) {
      setRenameError("名称不能为空");
      return;
    }
    if (
      next !== targetKb.name &&
      candidates.some((c) => c.mine && c.id !== targetKb.id && c.name === next)
    ) {
      setRenameError("已存在同名知识库，请换一个名称");
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      const updated = await updateKb(targetKb.id, { name: next });
      setCandidates((list) =>
        list.map((c) => (c.id === updated.id ? { ...c, name: updated.name } : c)),
      );
      setRenameOpen(false);
    } catch (e) {
      setRenameError(String(e));
    } finally {
      setRenaming(false);
    }
  };

  const standaloneTitle = props.kbNew.enabled
    ? pendingKbName
    : (targetKb?.name ?? ownKb?.name ?? pendingKbName);
  const standaloneSub = props.kbNew.enabled
    ? "保存时自动创建为本智能体专有知识库"
    : targetKb
      ? targetKb.sourceAgentId === props.agentId
        ? "本智能体专有知识库；自动学习沉淀仅写入该库"
        : "其他智能体的专有知识库（不可用，请取消勾选）"
      : ownKb
        ? "勾选恢复为本智能体专有知识库"
        : "勾选后保存时自动创建本智能体专有知识库";
  const danglingTarget = kbLoaded && targetId != null && !targetKb;
  // 用户知识库候选：本人可见全量剔除智能体专有库（本智能体的由上方独立知识库选项
  // 单一承载，其他智能体的不可见——与保存端校验、运行时挂载同口径）
  const userKbCandidates = candidates.filter((kb) => !kb.sourceAgentId);

  return (
    <FormSection
      id="agent-sec-kb"
      no="5"
      title="知识库与上下文"
      description="对话中可引用的三类资料源：知识库（kb_* 工具）、历史会话（% 引用）、反馈记录（# 引用）"
    >
      <FormField
        label="独立知识库"
        hint="本智能体专有库（可写目标，单选）：勾选即绑定，自动学习沉淀仅写入该库；不勾选则写入全部可写的绑定库。名称可经「改名」弹窗变更（需唯一）"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/60">
            <Checkbox
              id="kb-target-own"
              checked={standaloneChecked}
              onChange={(e) => toggleStandalone(e.target.checked)}
              label={
                <span className="min-w-0">
                  <span className="block min-w-0 truncate">{standaloneTitle}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {standaloneSub}
                  </span>
                </span>
              }
            />
            {canRenameTarget ? (
              <Button variant="secondary" size="sm" className="ml-auto" onClick={openRename}>
                改名
              </Button>
            ) : null}
          </div>
          {danglingTarget ? (
            <p className="text-xs text-destructive">
              原独立知识库已删除或不可写，保存前请重新勾选或取消
            </p>
          ) : null}
        </div>
      </FormField>
      <FormField
        label="用户知识库"
        hint="可多选，对话中可读取；被分享的库为只读挂载。其他智能体的专有知识库不在此列"
      >
        {userKbCandidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            暂无可用知识库；可先到「知识库」页创建，或勾选上方「独立知识库」自动创建专有库
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {userKbCandidates.map((kb) => (
              <div
                key={kb.id}
                className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/60"
              >
                <Checkbox
                  id={`kb-bind-${kb.id}`}
                  label={<span className="min-w-0 truncate">{kb.name}</span>}
                  checked={(form.knowledgeBaseIds ?? []).includes(kb.id)}
                  onChange={(e) => toggleKb(kb.id, e.target.checked)}
                />
                {kb.role === "use" ? (
                  <span className="text-[11px] text-muted-foreground">（只读）</span>
                ) : null}
                {form.kbWriteTargetId === kb.id ? <Badge tone="success">独立·可写</Badge> : null}
              </div>
            ))}
          </div>
        )}
      </FormField>
      {renameOpen && targetKb ? (
        <DialogShell
          title="重命名独立知识库"
          subtitle={`变更智能体专有知识库「${targetKb.name}」的名称`}
          onClose={() => {
            if (!renaming) setRenameOpen(false);
          }}
          footer={
            <>
              <span className="flex-1" />
              <Button
                variant="secondary"
                size="sm"
                disabled={renaming}
                onClick={() => setRenameOpen(false)}
              >
                取消
              </Button>
              <Button size="sm" disabled={renaming} onClick={() => void submitRename()}>
                {renaming ? "保存中…" : "确认"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-1">
            <Input
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              aria-label="知识库名称"
              placeholder="知识库名称"
            />
            {renameError ? <p className="text-xs text-destructive">{renameError}</p> : null}
            <p className="text-xs text-muted-foreground">
              名称在本人知识库内需唯一；点击确认后立即生效
            </p>
          </div>
        </DialogShell>
      ) : null}
      <FormField
        label="对话收尾自动萃取沉淀"
        hint="开启后对话结束自动萃取知识并按路由落位：记忆条目→个人库精选层；知识库记录→绑定的可写库；技能修订建议→审计留痕待采纳；平台约束→管理员候选池（默认关闭）"
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={form.kbAutoLearn === true}
            onCheckedChange={(v) => patch({ kbAutoLearn: v })}
          />
          <span className="text-xs text-muted-foreground">
            {form.kbAutoLearn ? "已开启" : "已关闭"}
          </span>
        </div>
        {form.kbAutoLearn ? (
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            <RouteToggle
              label="记忆条目"
              desc="个性化事实/偏好 → 个人库 curated"
              checked={form.learnRoutes?.memory !== false}
              onChange={(v) => patch({ learnRoutes: { memory: v, kbRecord: form.learnRoutes?.kbRecord !== false, skillSuggestion: form.learnRoutes?.skillSuggestion !== false, platformNote: form.learnRoutes?.platformNote !== false } })}
            />
            <RouteToggle
              label="知识库记录"
              desc="状态/历史 → 上方可写目标库"
              checked={form.learnRoutes?.kbRecord !== false}
              onChange={(v) => patch({ learnRoutes: { memory: form.learnRoutes?.memory !== false, kbRecord: v, skillSuggestion: form.learnRoutes?.skillSuggestion !== false, platformNote: form.learnRoutes?.platformNote !== false } })}
            />
            <RouteToggle
              label="技能修订建议"
              desc="How-to → 审计留痕，采纳后进技能"
              checked={form.learnRoutes?.skillSuggestion !== false}
              onChange={(v) => patch({ learnRoutes: { memory: form.learnRoutes?.memory !== false, kbRecord: form.learnRoutes?.kbRecord !== false, skillSuggestion: v, platformNote: form.learnRoutes?.platformNote !== false } })}
            />
            <RouteToggle
              label="平台约束上报"
              desc="全平台环境事实 → 管理员候选池"
              checked={form.learnRoutes?.platformNote !== false}
              onChange={(v) => patch({ learnRoutes: { memory: form.learnRoutes?.memory !== false, kbRecord: form.learnRoutes?.kbRecord !== false, skillSuggestion: form.learnRoutes?.skillSuggestion !== false, platformNote: v } })}
            />
          </div>
        ) : null}
      </FormField>

      <ConversationScopePicker
        value={form.conversationScope ?? { enabled: false, agentIds: [] }}
        onChange={(conversationScope) => patch({ conversationScope })}
      />

      <FeedbackScopePicker
        value={form.feedbackScope ?? { enabled: false }}
        onChange={(feedbackScope) => patch({ feedbackScope })}
      />
    </FormSection>
  );
}

/** 默认专有库名去重：与本人既有库重名时追加序号 -2/-3…（保存端 409 重试同语义） */
function dedupeKbName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** 输入的窗口数字归一：空串=不限（undefined），非法/越界收敛到 1-99 */
function toScopeInt(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(n, 99);
}

/**
 * 反馈资源范围（# 反馈引用）：启用开关（默认关）+ 时间窗口。
 * 反馈不绑智能体，无范围多选；可见性固定为 member 本人 / admin 全量（与反馈页一致）。
 * 关闭时配置项置灰但仍展示，暗示开启后可配。
 */
function FeedbackScopePicker({
  value,
  onChange,
}: {
  value: AgentFeedbackScopeDTO;
  onChange: (scope: AgentFeedbackScopeDTO) => void;
}) {
  return (
    <FormField
      label="反馈引用（#）"
      hint="开启后可在对话中用 # 引用反馈记录（含正文、回复与截图）；引用范围与「全部反馈」都受以下配置限制"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2">
          <Switch
            checked={value.enabled}
            onCheckedChange={(v) => onChange({ ...value, enabled: v })}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-semibold">启用反馈引用</span>
            <span className="text-[11px] leading-snug text-muted-foreground">
              默认关闭；开启后可引用自己提交的反馈（管理员可引用全部用户的反馈）
            </span>
          </div>
        </div>

        <div
          className={cn(
            "grid gap-2.5 sm:grid-cols-2",
            !value.enabled && "pointer-events-none opacity-50",
          )}
          aria-disabled={!value.enabled}
        >
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">最近天数（1-99，留空不限）</span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="引用反馈的最近天数"
              placeholder="如 7"
              value={value.days ?? ""}
              onChange={(e) => onChange({ ...value, days: toScopeInt(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">最近条数（1-99，留空默认 10）</span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="引用反馈的最近条数"
              placeholder="如 20"
              value={value.limit ?? ""}
              onChange={(e) => onChange({ ...value, limit: toScopeInt(e.target.value) })}
            />
          </div>
        </div>
      </div>
    </FormField>
  );
}

/**
 * 会话资源范围（% 会话引用）：启用开关（默认关）+ 智能体多选（空=仅本智能体）+ 时间窗口。
 * 关闭时配置项置灰但仍展示，暗示开启后可配。
 */
function ConversationScopePicker({
  value,
  onChange,
}: {
  value: AgentConversationScopeDTO;
  onChange: (scope: AgentConversationScopeDTO) => void;
}) {
  const [options, setOptions] = useState<Array<{ id: string; name: string; mine: boolean }>>([]);
  const [loadError, setLoadError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 仅用于手动重试时触发重新加载
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchAgents();
        if (cancelled) return;
        setLoadError(false);
        setOptions(list.map((a) => ({ id: a.id, name: a.name, mine: a._mine })));
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const toggleAgent = (id: string) => {
    const next = value.agentIds.includes(id)
      ? value.agentIds.filter((a) => a !== id)
      : [...value.agentIds, id];
    onChange({ ...value, agentIds: next });
  };

  return (
    <FormField
      label="会话引用（%）"
      hint="开启后可在对话中用 % 引用历史会话内容；引用范围与「全部会话」都受以下配置限制"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2">
          <Switch
            checked={value.enabled}
            onCheckedChange={(v) => onChange({ ...value, enabled: v })}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-semibold">启用会话引用</span>
            <span className="text-[11px] leading-snug text-muted-foreground">
              默认关闭；开启后对话输入框可用 % 引用历史会话
            </span>
          </div>
        </div>

        <div
          className={cn(
            "flex flex-col gap-2.5",
            !value.enabled && "pointer-events-none opacity-50",
          )}
          aria-disabled={!value.enabled}
        >
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              智能体范围（不勾选 = 仅引用绑定本智能体的会话）
            </span>
            {loadError ? (
              <button
                type="button"
                className="w-fit rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive-soft"
                onClick={() => setReloadTick((t) => t + 1)}
              >
                智能体列表加载失败，点击重试
              </button>
            ) : options.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无可选智能体</p>
            ) : (
              <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto rounded-[10px] border border-border bg-card p-2">
                {options.map((o) => {
                  const checked = value.agentIds.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggleAgent(o.id)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none",
                        checked ? "bg-primary-soft/40" : "hover:bg-muted",
                      )}
                    >
                      <Checkbox checked={checked} onChange={() => toggleAgent(o.id)} />
                      <span className="min-w-0 flex-1 truncate">{o.name}</span>
                      <Badge tone={o.mine ? "neutral" : "success"}>
                        {o.mine ? "我的" : "共享"}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">最近天数（1-99，留空不限）</span>
              <Input
                type="number"
                min={1}
                max={99}
                aria-label="引用会话的最近天数"
                placeholder="如 7"
                value={value.days ?? ""}
                onChange={(e) => onChange({ ...value, days: toScopeInt(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">最近条数（1-99，留空默认 10）</span>
              <Input
                type="number"
                min={1}
                max={99}
                aria-label="引用会话的最近条数"
                placeholder="如 20"
                value={value.limit ?? ""}
                onChange={(e) => onChange({ ...value, limit: toScopeInt(e.target.value) })}
              />
            </div>
          </div>
        </div>
      </div>
    </FormField>
  );
}

/** 萃取路由子开关（知识体系轮 P3）：标签+说明+勾选，无表单域外壳 */
function RouteToggle(props: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded border p-2">
      <Switch checked={props.checked} onCheckedChange={props.onChange} />
      <span className="min-w-0">
        <span className="block text-xs font-medium">{props.label}</span>
        <span className="block text-xs text-muted-foreground">{props.desc}</span>
      </span>
    </label>
  );
}
