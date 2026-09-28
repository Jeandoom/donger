import { useEffect, useState } from "react";
import { Checkbox } from "../../components/ui/checkbox";
import { FormField, FormSection } from "../../components/ui/form-section";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { fetchKnowledgeBases } from "../../lib/kb";
import type { AgentEditorForm } from "./model";

/**
 * 知识库配置分区（spec §10.2，M3）：绑定已有库多选（可读即可绑，被分享库只读挂载）
 * + 「独立知识库」创建（保存时建库回填，库在知识库模块可见）+ 自动学习开关（默认关）。
 */
export function KnowledgeSection(props: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  /** 新建独立库的名称（保存时先建库再回填 knowledgeBaseIds；不入 agent 字段） */
  kbNewName: string;
  onKbNewNameChange: (name: string) => void;
}) {
  const { form, patch } = props;
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string; role: string }>>(
    [],
  );

  useEffect(() => {
    fetchKnowledgeBases()
      .then((libs) =>
        setCandidates(
          libs.filter((l) => !l.builtin).map((l) => ({ id: l.id, name: l.name, role: l._role })),
        ),
      )
      .catch(() => setCandidates([]));
  }, []);

  const toggleKb = (id: string, checked: boolean): void => {
    const current = form.knowledgeBaseIds ?? [];
    const next = checked ? [...current, id] : current.filter((x) => x !== id);
    patch({ knowledgeBaseIds: next });
  };

  return (
    <FormSection
      id="agent-sec-kb"
      no="5"
      title="知识库"
      description="绑定知识库后，智能体可经 kb_* 工具按需查阅/维护；自动学习在对话收尾后把有价值信息沉淀进可写库"
    >
      <FormField label="绑定的知识库" hint="可多选；被分享的库为只读挂载">
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            暂无可用知识库；可先到「知识库」页创建，或在下方直接创建独立知识库
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {candidates.map((kb) => (
              <label
                key={kb.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/60"
              >
                <Checkbox
                  checked={(form.knowledgeBaseIds ?? []).includes(kb.id)}
                  onChange={(e) => toggleKb(kb.id, e.target.checked)}
                />
                <span className="min-w-0 truncate">{kb.name}</span>
                {kb.role === "use" ? (
                  <span className="text-[11px] text-muted-foreground">（只读）</span>
                ) : null}
              </label>
            ))}
          </div>
        )}
      </FormField>
      <FormField label="独立知识库" hint="保存时自动创建并绑定（可写）；留空则不创建">
        <Input
          value={props.kbNewName}
          onChange={(e) => props.onKbNewNameChange(e.target.value)}
          placeholder={`${form.name || "本智能体"}-知识库`}
        />
      </FormField>
      <FormField
        label="自动学习与记忆"
        hint="开启后对话结束会自动梳理有价值信息写入绑定的可写库（有修订记录可回溯；默认关闭）"
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
    </FormSection>
  );
}
