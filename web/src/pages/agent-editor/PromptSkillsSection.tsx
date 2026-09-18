import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Checkbox } from "../../components/ui/checkbox";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import type { AgentMeta } from "../../lib/agents";
import {
  filterSkillSelectorOptions,
  getDefaultSkillOptions,
  mergeSkillSelectorOptions,
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

  const allOptions = useMemo(
    () => mergeSkillSelectorOptions(meta.skills, form.skills),
    [meta.skills, form.skills],
  );
  const filteredOptions = useMemo(
    () => filterSkillSelectorOptions(allOptions, query),
    [allOptions, query],
  );
  const defaultSkillOptions = useMemo(
    () => getDefaultSkillOptions(meta.skills, form.skills),
    [meta.skills, form.skills],
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
        hint="勾选后运行时按 SKILL.md 装配；点击已选 chip 移除"
      >
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-muted/40 p-3">
          {form.skills.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {form.skills.map((id) => (
                <button
                  key={id}
                  type="button"
                  title="点击移除"
                  onClick={() => toggleSkill(id)}
                  className="rounded-full bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary transition-opacity hover:opacity-75"
                >
                  {id} ×
                </button>
              ))}
            </div>
          ) : null}
          <div className="relative">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索技能名称、ID 或描述…"
              className="h-9 w-full rounded-lg border border-border bg-card py-2 pr-3 pl-8 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {filteredOptions.length ? (
              filteredOptions.map((option) => {
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
              })
            ) : (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {allOptions.length ? "没有匹配的技能" : "暂无可选技能"}
              </p>
            )}
          </div>
        </div>
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
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
        <FormField label="LLM 预设" hint="留空则使用系统默认">
          <Select
            value={form.llm.presetId ?? ""}
            onChange={(e) => patch({ llm: { presetId: e.target.value || undefined } })}
          >
            <option value="">系统默认</option>
            {meta.llmPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.model}）
              </option>
            ))}
          </Select>
        </FormField>
      </div>
    </FormSection>
  );
}
