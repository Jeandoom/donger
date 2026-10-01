import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Checkbox } from "../../components/ui/checkbox";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import {
  type AgentConversationScopeDTO,
  type AgentFeedbackScopeDTO,
  fetchAgents,
} from "../../lib/agents";
import { fetchKnowledgeBases } from "../../lib/kb";
import { cn } from "../../lib/utils";
import type { AgentEditorForm } from "./model";

/**
 * 知识库与上下文分区（specs/2026-09-29-agent-editor-ui-redesign.md §4）：三类对话中
 * 可引用的资料源收拢一区——知识库（kb_* 工具：绑定/独立库/自动学习）、历史会话
 * （% 引用）、反馈记录（# 引用）。后两者自「资源」区并入（同为引用面，语义同族）。
 *
 * 独立知识库 = 可写目标单选勾选（specs/2026-10-01-agent-own-kb-picker-design.md §2.1）：
 * 候选限本人可管理库（个人库除外）；「＋ 新建」伪行保留懒建库，名称留空由保存兜底默认名。
 */
export function KnowledgeSection(props: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  /** 「＋ 新建独立知识库」伪行状态（保存时先建库回填 kbWriteTargetId；不入 agent 字段） */
  kbNew: { enabled: boolean; name: string };
  onKbNewChange: (next: { enabled: boolean; name: string }) => void;
}) {
  const { form, patch } = props;
  const [candidates, setCandidates] = useState<
    Array<{ id: string; name: string; role: string; personal: boolean }>
  >([]);
  const [kbLoaded, setKbLoaded] = useState(false);

  useEffect(() => {
    fetchKnowledgeBases()
      .then((libs) => {
        setCandidates(
          libs
            .filter((l) => !l.builtin)
            .map((l) => ({ id: l.id, name: l.name, role: l._role, personal: l.personal })),
        );
        setKbLoaded(true);
      })
      .catch(() => {
        setCandidates([]);
        setKbLoaded(true);
      });
  }, []);

  // 独立库候选：本人可管理、非个人库（个人库是跨智能体的记忆面，不作为 agent 专属可写目标）
  const writeCandidates = candidates.filter((kb) => kb.role === "manage" && !kb.personal);
  const danglingTarget =
    kbLoaded &&
    form.kbWriteTargetId != null &&
    !writeCandidates.some((k) => k.id === form.kbWriteTargetId);

  const toggleKb = (id: string, checked: boolean): void => {
    const current = form.knowledgeBaseIds ?? [];
    const next = checked ? [...current, id] : current.filter((x) => x !== id);
    patch({ knowledgeBaseIds: next });
  };

  // 独立蕴含绑定：选中目标由保存端幂等并入 knowledgeBaseIds，这里同步勾上让两处 UI 即时一致
  const selectTarget = (id: string, checked: boolean): void => {
    patch({ kbWriteTargetId: checked ? id : null });
    if (checked) {
      toggleKb(id, true);
      if (props.kbNew.enabled) props.onKbNewChange({ enabled: false, name: "" });
    }
  };

  const toggleNew = (checked: boolean): void => {
    props.onKbNewChange({ enabled: checked, name: props.kbNew.name });
    if (checked) patch({ kbWriteTargetId: null });
  };

  return (
    <FormSection
      id="agent-sec-kb"
      no="5"
      title="知识库与上下文"
      description="对话中可引用的三类资料源：知识库（kb_* 工具）、历史会话（% 引用）、反馈记录（# 引用）"
    >
      <FormField label="绑定的知识库" hint="可多选；被分享的库为只读挂载">
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            暂无可用知识库；可先到「知识库」页创建，或在下方勾选「新建独立知识库」
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {candidates.map((kb) => (
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
      <FormField
        label="独立知识库"
        hint="可写目标（单选）：自动学习沉淀写入该库；不勾选则写入全部可写的绑定库"
      >
        <div className="flex flex-col gap-1.5">
          {writeCandidates.map((kb) => (
            <div
              key={kb.id}
              className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/60"
            >
              <Checkbox
                id={`kb-target-${kb.id}`}
                label={<span className="min-w-0 truncate">{kb.name}</span>}
                checked={form.kbWriteTargetId === kb.id}
                onChange={(e) => selectTarget(kb.id, e.target.checked)}
              />
            </div>
          ))}
          <div className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/60">
            <Checkbox
              id="kb-target-new"
              label={<span>新建独立知识库</span>}
              checked={props.kbNew.enabled}
              onChange={(e) => toggleNew(e.target.checked)}
            />
          </div>
          {props.kbNew.enabled ? (
            <Input
              value={props.kbNew.name}
              onChange={(e) => props.onKbNewChange({ ...props.kbNew, name: e.target.value })}
              placeholder={`${form.name || "本智能体"}-知识库`}
              aria-label="新建独立知识库名称"
            />
          ) : null}
          {danglingTarget ? (
            <p className="text-xs text-destructive">
              原独立知识库已删除或不可写，保存前请重新勾选或取消
            </p>
          ) : null}
        </div>
      </FormField>
      <FormField
        label="自动学习与记忆"
        hint="开启后对话结束会自动梳理有价值信息写入独立知识库（未指定时写入全部可写的绑定库；有修订记录可回溯；默认关闭）"
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
