import { Lock, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { Checkbox } from "../../components/ui/checkbox";
import { FormField, FormSection } from "../../components/ui/form-section";
import { RadioCard } from "../../components/ui/radio-card";
import { Segmented } from "../../components/ui/segmented";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import type { ConnectorDTO } from "../../lib/connectors";
import { cn } from "../../lib/utils";
import type { AgentEditorForm, ScenarioIssue } from "./model";

const BUILTIN_MCPS = [
  { name: "donger-kb", desc: "知识库读写检索 · 恒挂载" },
  { name: "donger-git", desc: "Git 工作区/平台 · 绑定仓库后挂载" },
  { name: "donger-platform", desc: "平台元工具 · 仅内置智能体" },
];

export function ToolsPermsSection({
  form,
  patch,
  tools,
  connectors,
  issues,
  mcpJsonText,
  onMcpJsonTextChange,
  mcpJsonError,
  onMcpJsonErrorChange,
}: {
  form: AgentEditorForm;
  patch: (p: Partial<AgentEditorForm>) => void;
  tools: string[];
  connectors: ConnectorDTO[];
  issues: ScenarioIssue[];
  /** 内联 MCP JSON 文本与解析错误提升到页面持有（保存前阻断校验依赖它） */
  mcpJsonText: string;
  onMcpJsonTextChange: (text: string) => void;
  mcpJsonError: string | null;
  onMcpJsonErrorChange: (error: string | null) => void;
}) {
  const [toolQuery, setToolQuery] = useState("");
  const [mcpAdvancedOpen, setMcpAdvancedOpen] = useState(false);

  const filteredTools = useMemo(() => {
    const q = toolQuery.trim().toLowerCase();
    return q ? tools.filter((t) => t.toLowerCase().includes(q)) : tools;
  }, [tools, toolQuery]);

  // 外部加载/保存回显后同步 JSON 文本（仅当文本与 form 不一致时，避免打断编辑）；
  // mcpJsonText 在依赖内是安全的：合法编辑已同步进 form，非法中间态在 catch 中跳过
  useEffect(() => {
    try {
      if (JSON.stringify(JSON.parse(mcpJsonText)) !== JSON.stringify(form.mcpServers)) {
        onMcpJsonTextChange(JSON.stringify(form.mcpServers, null, 2));
        onMcpJsonErrorChange(null);
      }
    } catch {
      // 编辑中（非法中间态）：等待用户改完，不覆盖
    }
  }, [form.mcpServers, mcpJsonText, onMcpJsonTextChange, onMcpJsonErrorChange]);

  const editMcpJson = (text: string) => {
    onMcpJsonTextChange(text);
    try {
      const parsed = JSON.parse(text);
      onMcpJsonErrorChange(null);
      patch({ mcpServers: parsed });
    } catch (e) {
      onMcpJsonErrorChange(e instanceof Error ? e.message : "JSON 解析失败");
    }
  };

  const toggleWhitelistTool = (t: string, checked: boolean) => {
    patch({
      tools: {
        mode: "whitelist",
        whitelist: checked
          ? [...form.tools.whitelist, t]
          : form.tools.whitelist.filter((x) => x !== t),
      },
    });
  };

  const toggleConnector = (id: string, checked: boolean) => {
    const current = form.connectorIds ?? [];
    patch({ connectorIds: checked ? [...current, id] : current.filter((x) => x !== id) });
  };

  return (
    <FormSection
      id="agent-sec-tools"
      no="3"
      title="工具与权限"
      description="智能体能用哪些工具、以什么权限运行"
    >
      <FormField label="默认对话模式" hint="会话中可临时切换；无人值守任务恒按变更前问询">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <RadioCard
            name="agent-perm-mode"
            value="ask_before_change"
            checked={form.defaultPermissionMode !== "full_access"}
            onChange={() => patch({ defaultPermissionMode: "ask_before_change" })}
            title="变更前问询（推荐）"
            description="写入/高危操作先弹审批卡确认后再执行"
          />
          <RadioCard
            name="agent-perm-mode"
            value="full_access"
            tone="danger"
            checked={form.defaultPermissionMode === "full_access"}
            onChange={() => patch({ defaultPermissionMode: "full_access" })}
            title="完全权限"
            description="跳过审批卡直接执行（deploy/push 等高危操作不再询问），需谨慎"
          />
        </div>
      </FormField>

      <FormField
        label="工具范围"
        hint={
          form.tools.mode === "whitelist"
            ? "仅勾选的工具可被调用"
            : "全部工具可用（含文件写入与命令执行）"
        }
      >
        <Segmented
          name="工具范围"
          value={form.tools.mode}
          onChange={(mode) => patch({ tools: { mode, whitelist: form.tools.whitelist } })}
          options={[
            { value: "all", label: "全部工具" },
            {
              value: "whitelist",
              label: `白名单${form.tools.whitelist.length ? ` · 已选 ${form.tools.whitelist.length}` : ""}`,
            },
          ]}
        />
        {form.tools.mode === "whitelist" ? (
          <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-muted/40 p-3">
            <div className="relative">
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                placeholder="搜索工具名，如 bash、edit…"
                className="h-9 w-full rounded-lg border border-border bg-card py-2 pr-3 pl-8 text-[13px] placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
              />
            </div>
            <div className="grid max-h-56 gap-0.5 overflow-y-auto sm:grid-cols-2">
              {filteredTools.map((t) => (
                <label
                  key={t}
                  htmlFor={`agent-tool-${t}`}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/70"
                >
                  <Checkbox
                    id={`agent-tool-${t}`}
                    checked={form.tools.whitelist.includes(t)}
                    onChange={(e) => toggleWhitelistTool(t, e.target.checked)}
                  />
                  <span className="truncate font-mono text-xs">{t}</span>
                </label>
              ))}
              {filteredTools.length === 0 ? (
                <p className="col-span-full px-2 py-4 text-center text-xs text-muted-foreground">
                  没有匹配的工具
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </FormField>

      {issues.map((issue) => (
        <div
          key={issue.message}
          className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-warning"
        >
          <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
          <span className="flex-1">{issue.message}</span>
        </div>
      ))}

      <FormField label="MCP 工具" hint="内置服务随配置自动挂载；连接器开关启用">
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-muted/40 p-3">
          <div className="flex flex-col gap-0.5">
            {BUILTIN_MCPS.map((m) => (
              <div
                key={m.name}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
              >
                <Lock size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                <span className="font-mono text-xs">{m.name}</span>
                <span className="flex-1 truncate text-[11px] text-muted-foreground">{m.desc}</span>
                <Badge>内置</Badge>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-0.5">
            {connectors.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                暂无可用连接器，可到
                <Link to="/connectors" className="mx-0.5 text-primary hover:underline">
                  连接器页
                </Link>
                创建。
              </p>
            ) : (
              connectors.map((c) => {
                let host = c.url;
                try {
                  host = new URL(c.url).host;
                } catch {
                  // 非法 URL 原样展示
                }
                return (
                  <label
                    key={c.id}
                    htmlFor={`agent-connector-${c.id}`}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/70",
                      !c.enabled && "opacity-60",
                    )}
                  >
                    <Switch
                      id={`agent-connector-${c.id}`}
                      checked={(form.connectorIds ?? []).includes(c.id)}
                      onCheckedChange={(v) => toggleConnector(c.id, v)}
                      disabled={!c.enabled}
                    />
                    <span className="font-mono text-xs">{c.name}</span>
                    <span className="flex-1 truncate text-[11px] text-muted-foreground">
                      {host}
                    </span>
                    {c.shareScope === "global" ? <Badge tone="success">全局</Badge> : null}
                    {!c.enabled ? <Badge tone="warning">已停用</Badge> : null}
                  </label>
                );
              })
            )}
          </div>
          <div className="rounded-lg border border-border bg-card">
            <button
              type="button"
              onClick={() => setMcpAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              <span className={cn("transition-transform", mcpAdvancedOpen && "rotate-90")}>▸</span>
              高级：内联 MCP Servers（JSON）
              <span className="flex-1" />
              <Badge tone="danger">危险</Badge>
            </button>
            {mcpAdvancedOpen ? (
              <div className="flex flex-col gap-1.5 border-t border-border p-3">
                <Textarea
                  mono
                  rows={6}
                  value={mcpJsonText}
                  onChange={(e) => editMcpJson(e.target.value)}
                  className={cn(mcpJsonError && "border-destructive focus:border-destructive")}
                  spellCheck={false}
                />
                {mcpJsonError ? (
                  <p className="text-[11px] font-medium text-destructive">
                    JSON 解析失败：{mcpJsonError}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    env/headers
                    中的密钥会加密入库；编辑时显示为掩码，留掩码即保留原值。与连接器重名时保存会被拒绝。
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </FormField>
    </FormSection>
  );
}
