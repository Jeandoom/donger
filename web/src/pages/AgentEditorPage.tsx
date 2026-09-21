import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  type AgentMeta,
  createAgent,
  duplicateAgent,
  fetchAgent,
  fetchAgentMeta,
  updateAgent,
} from "../lib/agents";
import { type ConnectorDTO, fetchConnectors } from "../lib/connectors";
import { fetchCredentialTemplates } from "../lib/skills";
import { cn } from "../lib/utils";
import { BasicSection } from "./agent-editor/BasicSection";
import { IntegrationSection } from "./agent-editor/IntegrationSection";
import {
  AGENT_EDITOR_SECTIONS,
  type AgentEditorForm,
  emptyAgent,
  REPO_NAME_PATTERN,
  scenarioIssues,
} from "./agent-editor/model";
import { PromptSkillsSection } from "./agent-editor/PromptSkillsSection";
import { ResourcesSection } from "./agent-editor/ResourcesSection";
import { ToolsPermsSection } from "./agent-editor/ToolsPermsSection";

/**
 * 智能体配置页（重构版，specs/2026-09-18-agent-editor-redesign.md）：
 * sticky 顶栏/底栏 + 左锚点导航（scrollspy）+ 五分区卡片。
 */
export function AgentEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const navigate = useNavigate();
  const location = useLocation();

  const [meta, setMeta] = useState<AgentMeta>({
    skills: [],
    skillGroups: [],
    tools: [],
    llmPresets: [],
  });
  const [form, setForm] = useState<AgentEditorForm>(emptyAgent);
  const [baseline, setBaseline] = useState<string>(JSON.stringify(emptyAgent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // 复制/保存产生的装备告警：路由 state（列表页复制跳入）或本页 save 设置
  const [warnings, setWarnings] = useState<string[] | undefined>(
    (location.state as { warnings?: string[] } | null)?.warnings,
  );
  const [duplicating, setDuplicating] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(AGENT_EDITOR_SECTIONS[0].id);
  const [connectors, setConnectors] = useState<ConnectorDTO[]>([]);
  const [gitCredentialOptions, setGitCredentialOptions] = useState<
    Array<{ code: string; name: string; repoUrl?: string }>
  >([]);
  const [mcpJsonText, setMcpJsonText] = useState("[]");
  const [mcpJsonError, setMcpJsonError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const scrollRootRef = useRef<HTMLDivElement>(null);

  const patch = (p: Partial<AgentEditorForm>) => setForm((f) => ({ ...f, ...p }));

  useEffect(() => {
    fetchAgentMeta()
      .then(setMeta)
      .catch(() => {});
  }, []);

  // git 用途凭证模板（kind=git）：仓库凭证下拉选项；值不注入 env，仅工具现取
  useEffect(() => {
    fetchCredentialTemplates()
      .then((templates) =>
        setGitCredentialOptions(
          templates
            .filter((t) => t.kind === "git")
            .map((t) => ({ code: t.code, name: t.name, repoUrl: t.repoUrl })),
        ),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchConnectors()
      .then(setConnectors)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isNew && id) {
      setReadOnly(false);
      fetchAgent(id)
        .then((a) => {
          if (a.editable === false || !Array.isArray(a.skills)) {
            setReadOnly(true);
            setForm({ ...emptyAgent, name: a.name, description: a.description ?? "" });
            return;
          }
          const loaded: AgentEditorForm = {
            name: a.name,
            description: a.description ?? "",
            systemPrompt: a.systemPrompt ?? "",
            skills: a.skills,
            defaultSkill: a.defaultSkill,
            tools: a.tools,
            mcpServers: a.mcpServers,
            connectorIds: a.connectorIds ?? [],
            credentials: a.credentials ?? [],
            gitRepositories: a.gitRepositories ?? [],
            extensionDirectories: a.extensionDirectories ?? [],
            scenario: a.scenario,
            gitAllowShellGit: a.gitAllowShellGit ?? false,
            defaultPermissionMode: a.defaultPermissionMode ?? "ask_before_change",
            conversationScope: a.conversationScope ?? { enabled: false, agentIds: [] },
          };
          setForm(loaded);
          setBaseline(JSON.stringify(loaded));
        })
        .catch(() => navigate("/agents"));
    }
  }, [id, isNew, navigate]);

  // scrollspy：观察 5 个分区进入滚动容器上沿区域时高亮导航
  // biome-ignore lint/correctness/useExhaustiveDependencies: readOnly/isNew 驱动集成分区条件挂载，形态切换后需重建观察
  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        }
      },
      { root, rootMargin: "-72px 0px -65% 0px", threshold: 0 },
    );
    for (const s of AGENT_EDITOR_SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [readOnly, isNew]);

  const dirty = JSON.stringify(form) !== baseline;
  const issues = useMemo(() => scenarioIssues(form), [form]);
  const issuesBySection = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of issues) map.set(issue.section, (map.get(issue.section) ?? 0) + 1);
    return map;
  }, [issues]);

  async function save() {
    setError(undefined);
    if (!form.name.trim()) {
      setError("请填写名称");
      nameInputRef.current?.focus();
      document
        .getElementById(AGENT_EDITOR_SECTIONS[0].id)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (mcpJsonError) {
      setError(`内联 MCP JSON 未修复（${mcpJsonError}），保存已阻断`);
      setActiveSection(AGENT_EDITOR_SECTIONS[2].id);
      document
        .getElementById(AGENT_EDITOR_SECTIONS[2].id)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // 与后端 AgentGitRepositorySchema 同源校验：非法目录名一旦落库，读路径会让整个 agent 列表 500
    for (const r of form.gitRepositories) {
      if (!REPO_NAME_PATTERN.test(r.name)) {
        setError(
          `仓库目录名「${r.name || "（空）"}」不合法：需以字母/数字开头，仅含字母数字 . _ -，长度 1-64`,
        );
        setActiveSection(AGENT_EDITOR_SECTIONS[3].id);
        document
          .getElementById(AGENT_EDITOR_SECTIONS[3].id)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
    setSaving(true);
    setWarnings(undefined);
    try {
      const saved = isNew ? await createAgent(form) : await updateAgent(id ?? "", form);
      if (saved.warnings && saved.warnings.length > 0) {
        // 装备告警不阻断：后端已保存成功，更新基线消除未保存标记，留在编辑页展示告警
        setWarnings(saved.warnings);
        setBaseline(JSON.stringify(form));
        setSaving(false);
        return;
      }
      navigate(`/agents/${saved.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // 复制当前智能体：成功后跳副本详情页（warnings 经路由 state 展示）
  const handleDuplicate = async (): Promise<void> => {
    if (!id || isNew) return;
    setDuplicating(true);
    setError(undefined);
    try {
      const saved = await duplicateAgent(id);
      navigate(`/agents/${saved.id}`, { state: { warnings: saved.warnings } });
    } catch (e) {
      setError(String(e));
    } finally {
      setDuplicating(false);
    }
  };

  if (readOnly && !isNew && id) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 p-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-[22px] font-bold leading-7">{form.name}</h1>
            <Link
              to={`/agents/${id}/chat`}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
            >
              对话
            </Link>
          </div>
          {form.description ? (
            <p className="text-sm text-muted-foreground">{form.description}</p>
          ) : null}
          <p className="rounded border bg-muted/40 p-3 text-sm text-muted-foreground">
            这是共享智能体。你可以使用它进行对话，但无权查看或编辑创建者的详细配置。
          </p>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => navigate("/agents")}
          >
            返回智能体管理
          </button>
        </div>
      </div>
    );
  }

  const sectionProps = { form, patch };

  return (
    <div ref={scrollRootRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Sticky 顶栏 */}
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card/95 px-5 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate("/agents")}
          title="返回智能体管理"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ←
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-[15px] font-semibold">{isNew ? "新建智能体" : "编辑智能体"}</h1>
          {!isNew && form.name ? (
            <span className="truncate text-[13px] text-muted-foreground">· {form.name}</span>
          ) : null}
        </div>
        {dirty ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
            未保存
          </span>
        ) : null}
        <span className="flex-1" />
        {!isNew && id ? (
          <Link
            to={`/agents/${id}/chat`}
            className="hidden rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted sm:inline-flex"
          >
            对话
          </Link>
        ) : null}
        {!isNew && id ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleDuplicate()}
            disabled={duplicating}
          >
            {duplicating ? "复制中…" : "复制"}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={() => navigate("/agents")}>
          取消
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || !form.name}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </header>

      {/* 移动端：横向分区 chips（sticky 于顶栏下） */}
      <nav className="sticky top-16 z-10 flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card/95 px-4 py-2 backdrop-blur md:hidden">
        {AGENT_EDITOR_SECTIONS.map((s) => {
          const hidden = s.id === "agent-sec-integration" && isNew;
          if (hidden) return null;
          const count = issuesBySection.get(s.id) ?? 0;
          const active = activeSection === s.id;
          return (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground hover:opacity-80",
              )}
            >
              {s.label}
              {count > 0 ? <span className="ml-1 font-semibold text-warning">①</span> : null}
            </a>
          );
        })}
      </nav>

      <div className="flex flex-1 items-start">
        {/* 桌面：左锚点导航（sticky）——高度必须保持内容自然高度（items-start 下的 auto），
            一旦 self-stretch 拉满父容器高度，sticky 将无滚动余量而失效（2026-09-18 生产实测） */}
        <nav className="sticky top-16 hidden w-56 shrink-0 flex-col gap-1 border-r border-border bg-card/60 p-4 md:flex">
          <p className="px-3 pb-1 text-[11px] font-semibold text-muted-foreground/70">配置分区</p>
          {AGENT_EDITOR_SECTIONS.map((s) => {
            if (s.id === "agent-sec-integration" && isNew) return null;
            const count = issuesBySection.get(s.id) ?? 0;
            const active = activeSection === s.id;
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setActiveSection(s.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors",
                  active
                    ? "bg-primary-soft font-semibold text-primary"
                    : "text-foreground hover:bg-muted",
                )}
              >
                {s.label}
                <span className="flex-1" />
                {count > 0 ? <Badge tone="warning">{count}</Badge> : null}
              </a>
            );
          })}
          <p className="mt-4 px-3 text-[10px] leading-snug text-muted-foreground/60">
            徽标 = 该区有需处理的场景提示
          </p>
        </nav>

        {/* 内容滚动区：五分区 */}
        <main className="min-w-0 flex-1 space-y-5 p-5 pb-28 md:p-6">
          {error ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {warnings && warnings.length > 0 ? (
            <div className="space-y-1 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
              <p className="font-medium">装备提示（已保存，可稍后处理）</p>
              <ul className="list-inside list-disc text-muted-foreground">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <BasicSection
            {...sectionProps}
            issues={issues.filter((i) => i.section === "agent-sec-basic")}
            nameInputRef={nameInputRef}
          />
          <PromptSkillsSection {...sectionProps} meta={meta} />
          <ToolsPermsSection
            {...sectionProps}
            tools={meta.tools}
            connectors={connectors}
            issues={issues.filter((i) => i.section === "agent-sec-tools")}
            mcpJsonText={mcpJsonText}
            onMcpJsonTextChange={setMcpJsonText}
            mcpJsonError={mcpJsonError}
            onMcpJsonErrorChange={setMcpJsonError}
          />
          <ResourcesSection {...sectionProps} gitCredentialOptions={gitCredentialOptions} />
          {!isNew && id ? <IntegrationSection agentId={id} /> : null}
        </main>
      </div>

      {/* Sticky 底部保存栏 */}
      <footer className="sticky bottom-0 z-20 flex h-14 shrink-0 items-center gap-3 border-t border-border bg-card/95 px-5 backdrop-blur">
        {dirty ? (
          <span className="flex items-center gap-2 text-[13px]">
            <span className="h-[7px] w-[7px] rounded-full bg-warning" aria-hidden="true" />
            有未保存的更改
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">所有更改已保存</span>
        )}
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => navigate("/agents")}>
          取消
        </Button>
        <Button
          size="sm"
          className="px-5"
          onClick={() => void save()}
          disabled={saving || !form.name}
        >
          {saving ? "保存中…" : "保存"}
        </Button>
      </footer>
    </div>
  );
}
