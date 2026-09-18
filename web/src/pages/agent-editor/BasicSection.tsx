import { TriangleAlert } from "lucide-react";
import type { RefObject } from "react";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { RadioCard } from "../../components/ui/radio-card";
import { cn } from "../../lib/utils";
import type { AgentEditorForm, ScenarioIssue } from "./model";

const SCENARIOS: Array<{
  value: AgentEditorForm["scenario"];
  title: string;
  description: string;
}> = [
  { value: "code-dev", title: "代码项目 code-dev", description: "开发运维，需绑定 Git 仓库" },
  { value: "kb-qa", title: "知识库问答 kb-qa", description: "只读问答，工具白名单强制只读" },
  { value: "research", title: "调研分析 research", description: "可写知识库，产出报告" },
  { value: "ops", title: "运维操作 ops", description: "面向线上系统的运维动作" },
  { value: undefined, title: "不设置", description: "通用智能体，不做场景校验" },
];

export function BasicSection({
  form,
  patch,
  issues,
  nameInputRef,
}: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  /** 场景联动前置警示（inline 展示 + 跨区跳转链接，不阻断保存） */
  issues: ScenarioIssue[];
  nameInputRef?: RefObject<HTMLInputElement>;
}) {
  return (
    <FormSection id="agent-sec-basic" no="1" title="基本" description="名称、用途与场景定位">
      <FormField label="名称" required>
        <Input
          ref={nameInputRef}
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="如 donger-code-agent"
        />
      </FormField>
      <FormField label="描述" hint="列表页与路由展示；一句话说明该智能体做什么">
        <Input
          value={form.description ?? ""}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </FormField>
      <FormField label="场景" hint="场景决定装配校验与推荐配置；不设置则跳过场景校验">
        <div className="grid gap-2.5 sm:grid-cols-2">
          {SCENARIOS.map((s) => {
            const checked = form.scenario === s.value;
            return (
              <RadioCard
                key={s.title}
                name="agent-scenario"
                value={s.value ?? ""}
                checked={checked}
                onChange={() => patch({ scenario: s.value })}
                title={s.title}
                description={s.description}
                className={cn(s.value === undefined && checked && "sm:col-span-2")}
              />
            );
          })}
        </div>
      </FormField>

      {issues.map((issue) => (
        <div
          key={issue.message}
          className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-warning"
        >
          <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
          <span className="flex-1">{issue.message}</span>
          <a
            href={`#${issue.section === "agent-sec-basic" ? "agent-sec-resources" : issue.section}`}
            className="shrink-0 font-semibold hover:underline"
          >
            去处理 →
          </a>
        </div>
      ))}
    </FormSection>
  );
}
