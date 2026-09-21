import { ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Checkbox } from "../../components/ui/checkbox";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import type { AgentMeta } from "../../lib/agents";
import {
  filterSkillSelectorGroups,
  getDefaultSkillOptions,
  mergeSkillSelectorGroups,
  type SkillSelectorGroup,
} from "../../lib/skillSelector";
import type { AgentEditorForm } from "./model";

export function PromptSkillsSection({
  form,
  patch,
  meta,
}: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  meta: AgentMeta;
}) {
  const [query, setQuery] = useState("");
  // 组折叠状态：默认全部折叠、手动展开（specs/2026-09-21 §4.2 决策④）；搜索时命中组自动展开
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(
    () => mergeSkillSelectorGroups(meta.skillGroups, form.skills),
    [meta.skillGroups, form.skills],
  );
  const searching = query.trim().length > 0;
  const visibleGroups = useMemo(() => filterSkillSelectorGroups(groups, query), [groups, query]);
  const allOptions = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const defaultSkillOptions = useMemo(
    () => getDefaultSkillOptions(allOptions, form.skills),
    [allOptions, form.skills],
  );

  const toggleSkill = (id: string) => {
    const skills = form.skills.includes(id)
      ? form.skills.filter((s) => s !== id)
      : [...form.skills, id];
    // 默认技能若被移除需同步清空
    const defaultSkill =
      form.defaultSkill && !skills.includes(form.defaultSkill) ? undefined : form.defaultSkill;
    patch({ skills, defaultSkill });
  };

  // 静态快照语义：勾选仓库 = 当下把组内技能全部加入/移出（后续新增技能不自动跟随）
  const setGroupSkills = (group: SkillSelectorGroup, select: boolean) => {
    const ids = group.options.map((option) => option.id);
    const skills = select
      ? [...new Set([...form.skills, ...ids])]
      : form.skills.filter((s) => !ids.includes(s));
    const defaultSkill =
      form.defaultSkill && !skills.includes(form.defaultSkill) ? undefined : form.defaultSkill;
    patch({ skills, defaultSkill });
  };

  const toggleGroupExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <FormSection
      id="agent-sec-prompt"
      no="2"
      title="提示词与技能"
      description="定义智能体的思考方式与专业能力"
    >
      <FormField label="System Prompt" hint="追加到默认提示词之后，塑造角色与行为约束">
        <Textarea
          mono
          rows={5}
          value={form.systemPrompt ?? ""}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          placeholder="你是……熟悉……遵循……"
        />
      </FormField>

      <FormField
        label={`技能（已选 ${form.skills.length} 个）`}
        hint="勾选仓库即整组生效，或展开后逐个勾选；仓库后续新增的技能需重新勾一次"
      >
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-muted/40 p-3">
          <div className="relative">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索技能或仓库名称、ID、描述…"
              className="h-9 w-full rounded-lg border border-border bg-card py-2 pr-3 pl-8 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
            {visibleGroups.length ? (
              visibleGroups.map((group) => {
                const selectedCount = group.options.filter((o) =>
                  form.skills.includes(o.id),
                ).length;
                const allChecked = selectedCount === group.options.length;
                const open = searching || expanded.has(group.key);
                return (
                  <div key={group.key} className="rounded-lg border border-border bg-card">
                    <div className="flex items-center gap-1.5 py-1 pr-2 pl-1">
                      <button
                        type="button"
                        aria-label={open ? `折叠 ${group.label}` : `展开 ${group.label}`}
                        aria-expanded={open}
                        onClick={() => toggleGroupExpanded(group.key)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                      >
                        <ChevronRight
                          size={14}
                          className={
                            open ? "transition-transform rotate-90" : "transition-transform"
                          }
                        />
                      </button>
                      <Checkbox
                        aria-label={`勾选 ${group.label} 的全部技能`}
                        checked={allChecked}
                        indeterminate={selectedCount > 0 && !allChecked}
                        onChange={() => setGroupSkills(group, !allChecked)}
                      />
                      <button
                        type="button"
                        onClick={() => toggleGroupExpanded(group.key)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="truncate text-[13px] font-medium">{group.label}</span>
                        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                          {group.sourceLabel ?? group.description ?? ""}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                          已选 {selectedCount}/{group.options.length}
                        </span>
                      </button>
                    </div>
                    {open ? (
                      <div className="flex flex-col gap-0.5 border-t border-border px-1 py-1">
                        {group.options.map((option) => {
                          const checked = form.skills.includes(option.id);
                          return (
                            <label
                              key={option.id}
                              htmlFor={`agent-skill-${option.id}`}
                              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-muted/70"
                            >
                              <Checkbox
                                id={`agent-skill-${option.id}`}
                                checked={checked}
                                onChange={() => toggleSkill(option.id)}
                              />
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[13px] font-medium">
                                  {option.name || option.id}
                                </span>
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {option.id}
                                  {option.description ? ` · ${option.description}` : ""}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {allOptions.length || groups.length ? "没有匹配的技能" : "暂无可选技能"}
              </p>
            )}
          </div>
        </div>
      </FormField>

      <FormField label="默认 Skill" hint="对话时每次输入后自动触发">
        <Select
          value={form.defaultSkill ?? ""}
          onChange={(e) => patch({ defaultSkill: e.target.value || undefined })}
        >
          <option value="">不设置</option>
          {defaultSkillOptions.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name || skill.id}
              {skill.name && skill.name !== skill.id ? `（${skill.id}）` : ""}
            </option>
          ))}
        </Select>
      </FormField>
    </FormSection>
  );
}
