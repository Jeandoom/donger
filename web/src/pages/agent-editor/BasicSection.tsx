import { TriangleAlert } from "lucide-react";
import type { RefObject } from "react";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { RadioCard } from "../../components/ui/radio-card";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import type { AgentEditorForm, ScenarioIssue } from "./model";

/** 缺省内置（fail-open）：注册表加载失败时仍可配置；正常路径由 AgentEditorPage 传注册表过滤结果 */
const DEFAULT_NOTIFY_CHANNELS: Array<{
  id: "inapp" | "dingtalk" | "webhook" | "email";
  label: string;
}> = [
  { id: "inapp", label: "站内信" },
  { id: "dingtalk", label: "钉钉" },
  { id: "webhook", label: "Webhook" },
  { id: "email", label: "邮件" },
];

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
  notifyChannels = DEFAULT_NOTIFY_CHANNELS,
}: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  /** 场景联动前置警示（inline 展示 + 跨区跳转链接，不阻断保存） */
  issues: ScenarioIssue[];
  nameInputRef?: RefObject<HTMLInputElement>;
  /** 通知渠道选项（注册表驱动：outboundPush 且就绪的渠道；拍板 #2 未适配不展示） */
  notifyChannels?: Array<{ id: "inapp" | "dingtalk" | "webhook" | "email"; label: string }>;
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

      <FormField
        label="回复通知"
        hint="交互式对话中智能体每次回复后发送通知（最终与你在通知中心的渠道订阅取交集生效）；工作流调用的轮不发。查看对话或通知即标已读"
      >
        <div className="flex flex-col gap-2.5">
          <label className="flex w-fit items-center gap-2 text-sm">
            <Switch
              checked={form.notifyPolicy?.enabled ?? true}
              onCheckedChange={(v) =>
                patch({
                  notifyPolicy: { enabled: v, channels: form.notifyPolicy?.channels ?? ["inapp"] },
                })
              }
              aria-label="启用回复通知"
            />
            启用回复通知
          </label>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {notifyChannels.map((c) => {
              const checked = (form.notifyPolicy?.channels ?? ["inapp"]).includes(c.id);
              return (
                <label
                  key={c.id}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const current = form.notifyPolicy?.channels ?? ["inapp"];
                      const next = e.target.checked
                        ? [...new Set([...current, c.id])]
                        : current.filter((x) => x !== c.id);
                      if (next.length === 0) return; // 至少保留一个渠道
                      patch({
                        notifyPolicy: { enabled: form.notifyPolicy?.enabled ?? true, channels: next },
                      });
                    }}
                  />
                  {c.label}
                </label>
              );
            })}
          </div>
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
