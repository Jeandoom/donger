import { RefreshCw } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CronBuilder } from "../components/CronBuilder";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useDirtyGuard } from "../components/ui/dirty-guard";
import { FormField, FormSection } from "../components/ui/form-section";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { apiFetch } from "../lib/auth";
import { fetchAgents } from "../lib/agents";
import { validateCron } from "../lib/cronBuilder";
import { runStatusLabel, runStatusTone } from "../lib/runStatus";

type EventType = "system" | "schedule" | "call" | "message";

type MatcherKind =
  | "always"
  | "statusEq"
  | "bodyContains"
  | "bodyRegex"
  | "jsonPathEq"
  | "jsonPathGt"
  | "bodyFieldEq"
  | "headerEq";

/** matcher 字段值统一以 string 持有；buildMatcherPayload 时按 kind 转 number */
type MatcherFields = Record<string, string>;

interface MatcherDTO {
  kind: MatcherKind;
  value?: number | string;
  keyword?: string;
  pattern?: string;
  path?: string;
  field?: string;
  header?: string;
}

interface EventDTO {
  id: string;
  name: string;
  type: EventType;
  system?: {
    name: string;
    matcher?: MatcherDTO;
    subjects?: string[];
    timing?: "all" | "success" | "failed" | "stopped";
  };
  schedule?: {
    cron: string;
    mode: "unconditional" | "conditional";
    source?: { type: "http"; url: string; method: string } | { type: "file"; path: string };
    matcher?: MatcherDTO;
  };
  call?: {
    path: string;
    methods: string[];
    responseStatus: number;
    responseBody: string;
    matcher: MatcherDTO;
  };
  message?: {
    platform: "dingtalk" | "teambition";
    topic: string;
    filter?: {
      openConversationId?: string;
      orgId?: string;
      projectId?: string;
      allowFrom?: string[];
    };
    matcher?: MatcherDTO;
  };
}

interface FiringDTO {
  id: string;
  source: string;
  context: string;
  matchedWorkflowCount: number;
  firedAt: string;
}

interface RunDTO {
  id: string;
  workflowId: string;
  status: string;
  error?: string | null;
  conversationId?: string | null;
}

interface TestResult {
  sourceOutput: string;
  matched: boolean;
  debug?: unknown;
  error?: string;
}

/** 与后端 SYSTEM_EVENT_NAMES 注册表两端语义一致；
 * 完成事件（spec 2026-10-19-execution-completion-events-design）走 subjects/timing 过滤 */
const SYSTEM_EVENT_OPTIONS: { value: string; label: string }[] = [
  { value: "feedback.created", label: "新反馈提交（管理员）" },
  { value: "agent.execution.completed", label: "智能体执行完成" },
  { value: "workflow.execution.completed", label: "工作流执行完成" },
];

const COMPLETION_EVENT_NAMES = ["agent.execution.completed", "workflow.execution.completed"];
const isCompletionEventName = (name: string) => COMPLETION_EVENT_NAMES.includes(name);

const MATCHER_OPTIONS: { value: MatcherKind; label: string }[] = [
  { value: "always", label: "总是触发" },
  { value: "statusEq", label: "HTTP 状态码等于" },
  { value: "bodyContains", label: "文本包含关键词" },
  { value: "bodyRegex", label: "文本正则匹配" },
  { value: "jsonPathEq", label: "JSON 字段等于" },
  { value: "jsonPathGt", label: "JSON 字段大于" },
  { value: "bodyFieldEq", label: "Body 顶层字段等于" },
  { value: "headerEq", label: "HTTP Header 等于" },
];

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动",
  schedule: "定时",
  call: "调用",
  system: "系统",
  message: "平台消息",
};

function toMatcherFields(m?: MatcherDTO): { kind: MatcherKind; fields: MatcherFields } {
  if (!m) return { kind: "always", fields: {} };
  const { kind, ...rest } = m;
  return {
    kind,
    fields: Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [k, v == null ? "" : String(v)]),
    ),
  };
}

function buildMatcherPayload(kind: MatcherKind, m: MatcherFields): MatcherDTO {
  switch (kind) {
    case "always":
      return { kind };
    case "statusEq":
      return { kind, value: Number(m.value) };
    case "bodyContains":
      return { kind, keyword: m.keyword ?? "" };
    case "bodyRegex":
      return { kind, pattern: m.pattern ?? "" };
    case "jsonPathEq":
      return { kind, path: m.path ?? "", value: m.value ?? "" };
    case "jsonPathGt":
      return { kind, path: m.path ?? "", value: Number(m.value) };
    case "bodyFieldEq":
      return { kind, field: m.field ?? "", value: m.value ?? "" };
    case "headerEq":
      return { kind, header: m.header ?? "", value: m.value ?? "" };
  }
}

/** 匹配器必填字段校验：不填全的匹配器后端 zod 会 400（如 jsonPath path 空），在保存前给出人话 */
function matcherIssue(kind: MatcherKind, m: MatcherFields): string | null {
  switch (kind) {
    case "always":
      return null;
    case "statusEq":
      return /^\d+$/.test((m.value ?? "").trim()) ? null : "匹配条件：状态码需为非负整数";
    case "bodyContains":
      return (m.keyword ?? "").trim() ? null : "匹配条件：请填写关键词";
    case "bodyRegex":
      return (m.pattern ?? "").trim() ? null : "匹配条件：请填写正则表达式";
    case "jsonPathEq":
    case "jsonPathGt":
      if (!/^\$\.[a-zA-Z0-9_.]+$/.test((m.path ?? "").trim())) {
        return "匹配条件：JSON Path 需为 $.a.b.c 形式";
      }
      if (kind === "jsonPathGt" && !/^-?\d+(\.\d+)?$/.test((m.value ?? "").trim())) {
        return "匹配条件：比较值需为数字";
      }
      return null;
    case "bodyFieldEq":
      return (m.field ?? "").trim() ? null : "匹配条件：请填写顶层字段名";
    case "headerEq":
      return (m.header ?? "").trim() ? null : "匹配条件：请填写 Header 名";
  }
}

export function EventEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<EventType>("schedule");
  // schedule
  const [cron, setCron] = useState("0 9 * * *");
  const [scheduleMode, setScheduleMode] = useState<"unconditional" | "conditional">(
    "unconditional",
  );
  const [sourceType, setSourceType] = useState<"http" | "file">("http");
  const [httpUrl, setHttpUrl] = useState("");
  const [httpMethod, setHttpMethod] = useState("GET");
  const [filePath, setFilePath] = useState("");
  const [scheduleMatcher, setScheduleMatcher] = useState<{
    kind: MatcherKind;
    fields: MatcherFields;
  }>({
    kind: "always",
    fields: {},
  });
  // call
  const [callPath, setCallPath] = useState("");
  const [callResponse, setCallResponse] = useState("ok");
  const [callMatcher, setCallMatcher] = useState<{ kind: MatcherKind; fields: MatcherFields }>({
    kind: "always",
    fields: {},
  });
  // system
  const [systemName, setSystemName] = useState("feedback.created");
  const [systemMatcher, setSystemMatcher] = useState<{ kind: MatcherKind; fields: MatcherFields }>({
    kind: "always",
    fields: {},
  });
  // message（spec 2026-10-27-platform-message-subscription-design §4.2 D1；M1 平台=钉钉）
  const [messagePlatform, setMessagePlatform] = useState<"dingtalk" | "teambition">("dingtalk");
  const [messageTopic, setMessageTopic] = useState("robot.group");
  const [msgConvId, setMsgConvId] = useState("");
  const [msgAllowFrom, setMsgAllowFrom] = useState("");
  const [messageMatcher, setMessageMatcher] = useState<{
    kind: MatcherKind;
    fields: MatcherFields;
  }>({
    kind: "always",
    fields: {},
  });
  // 完成事件：主体多选 + 触发时机（D1/D8）
  const [subjects, setSubjects] = useState<string[]>([]);
  const [timing, setTiming] = useState("all");
  const [subjectOptions, setSubjectOptions] = useState<Array<{ id: string; name: string }>>([]);

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!id);

  // 触发记录（编辑态）
  const [firings, setFirings] = useState<FiringDTO[]>([]);
  const [workflowNames, setWorkflowNames] = useState<Map<string, string>>(new Map());
  const [expandedFiring, setExpandedFiring] = useState<string | null>(null);
  const [firingRuns, setFiringRuns] = useState<Record<string, RunDTO[]>>({});

  const snapshot = JSON.stringify({
    name,
    type,
    cron,
    scheduleMode,
    sourceType,
    httpUrl,
    httpMethod,
    filePath,
    scheduleMatcher,
    callResponse,
    callMatcher,
    systemName,
    systemMatcher,
    subjects,
    timing,
    messagePlatform,
    messageTopic,
    msgConvId,
    msgAllowFrom,
    messageMatcher,
  });
  const pristineRef = useRef<string | null>(null);
  useEffect(() => {
    if (loaded && pristineRef.current === null) pristineRef.current = snapshot;
  }, [loaded, snapshot]);
  const dirty = pristineRef.current !== null && snapshot !== pristineRef.current;
  const { attempt, dialog } = useDirtyGuard(dirty && !saving);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await apiFetch(`/api/events/${id}`);
      if (!r.ok) throw new Error(`加载失败（HTTP ${r.status}）`);
      const e = (await r.json()) as EventDTO;
      setName(e.name);
      setType(e.type);
      if (e.schedule) {
        setCron(e.schedule.cron);
        setScheduleMode(e.schedule.mode ?? "conditional");
        if (e.schedule.source?.type === "http") {
          setSourceType("http");
          setHttpUrl(e.schedule.source.url);
          setHttpMethod(e.schedule.source.method);
        } else if (e.schedule.source?.type === "file") {
          setSourceType("file");
          setFilePath(e.schedule.source.path);
        }
        setScheduleMatcher(toMatcherFields(e.schedule.matcher));
      }
      if (e.call) {
        setCallPath(e.call.path);
        setCallResponse(e.call.responseBody);
        setCallMatcher(toMatcherFields(e.call.matcher));
      }
      if (e.system) {
        setSystemName(e.system.name);
        setSubjects(e.system.subjects ?? []);
        setTiming(e.system.timing ?? "all");
        setSystemMatcher(toMatcherFields(e.system.matcher));
      }
      if (e.message) {
        setMessagePlatform(e.message.platform);
        setMessageTopic(e.message.topic);
        setMsgConvId(e.message.filter?.openConversationId ?? "");
        setMsgAllowFrom((e.message.filter?.allowFrom ?? []).join("\n"));
        setMessageMatcher(toMatcherFields(e.message.matcher));
      }
      setLoaded(true);
      pristineRef.current = null;
      // 触发记录 + 工作流名映射
      void apiFetch(`/api/events/${id}/firings`)
        .then((fr) => fr.json() as Promise<{ firings?: FiringDTO[] }>)
        .then((d) => setFirings(d.firings ?? []))
        .catch(() => setFirings([]));
      void apiFetch("/api/workflows")
        .then((wr) => wr.json() as Promise<{ workflows?: Array<{ id: string; name: string }> }>)
        .then((d) => setWorkflowNames(new Map((d.workflows ?? []).map((w) => [w.id, w.name]))))
        .catch(() => undefined);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 完成事件主体候选：智能体=我可使用（自有+共享）；工作流=本人所有（D4）
  const isCompletion = type === "system" && isCompletionEventName(systemName);
  useEffect(() => {
    if (type !== "system" || !isCompletionEventName(systemName)) return;
    let cancelled = false;
    void (async () => {
      try {
        if (systemName === "agent.execution.completed") {
          const ag = await fetchAgents();
          if (!cancelled) {
            setSubjectOptions(
              ag.map((a) => ({ id: a.id, name: a._mine ? a.name : `${a.name}（共享）` })),
            );
          }
        } else {
          const r = await apiFetch("/api/workflows");
          const d = (await r.json()) as { workflows?: Array<{ id: string; name: string }> };
          if (!cancelled) {
            setSubjectOptions((d.workflows ?? []).map((w) => ({ id: w.id, name: w.name })));
          }
        }
      } catch {
        if (!cancelled) setSubjectOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, systemName]);

  const buildPayload = () => {
    if (type === "schedule") {
      return {
        name,
        type,
        schedule: {
          cron: cron.trim(),
          mode: scheduleMode,
          ...(scheduleMode === "conditional"
            ? {
                source:
                  sourceType === "http"
                    ? { type: "http", url: httpUrl, method: httpMethod }
                    : { type: "file", path: filePath },
                matcher: buildMatcherPayload(scheduleMatcher.kind, scheduleMatcher.fields),
              }
            : {}),
        },
      };
    }
    if (type === "system") {
      if (isCompletionEventName(systemName)) {
        return { name, type, system: { name: systemName, subjects, timing } };
      }
      return {
        name,
        type,
        system: {
          name: systemName,
          matcher: buildMatcherPayload(systemMatcher.kind, systemMatcher.fields),
        },
      };
    }
    if (type === "message") {
      const allowFrom = msgAllowFrom
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        name,
        type,
        message: {
          platform: messagePlatform,
          topic: messageTopic,
          filter: {
            ...(msgConvId.trim() ? { openConversationId: msgConvId.trim() } : {}),
            ...(allowFrom.length ? { allowFrom } : {}),
          },
          matcher: buildMatcherPayload(messageMatcher.kind, messageMatcher.fields),
        },
      };
    }
    return {
      name,
      type,
      call: {
        // path 服务端所有：新建由后端生成；更新后端会忽略客户端值并保留原路径
        path: callPath || "/hooks/pending",
        methods: ["GET", "POST"],
        responseStatus: 200,
        responseBody: callResponse,
        matcher: buildMatcherPayload(callMatcher.kind, callMatcher.fields),
      },
    };
  };

  const validate = (): string | null => {
    if (!name.trim()) return "请填写名称";
    if (type === "schedule") {
      if (!cron.trim()) return "请配置定时表达式";
      // 语法门（与后端同构）：语法错的表达式过去能存进去但调度器静默跳过，永不触发
      const cronErr = validateCron(cron);
      if (cronErr) return `定时表达式非法：${cronErr}`;
      if (
        scheduleMode === "conditional" &&
        sourceType === "http" &&
        !/^https?:\/\/\S+/.test(httpUrl.trim())
      ) {
        return "有条件定时的数据源为 HTTP 时请填写合法 URL（http/https）";
      }
      if (scheduleMode === "conditional" && sourceType === "file" && !filePath.trim()) {
        return "有条件定时需填写文件路径";
      }
      if (scheduleMode === "conditional") {
        const mErr = matcherIssue(scheduleMatcher.kind, scheduleMatcher.fields);
        if (mErr) return mErr;
      }
    }
    if (type === "call") {
      const mErr = matcherIssue(callMatcher.kind, callMatcher.fields);
      if (mErr) return mErr;
    }
    if (type === "system") {
      if (isCompletionEventName(systemName)) {
        if (!subjects.length) return "完成事件请至少选择一个主体";
        return null;
      }
      const mErr = matcherIssue(systemMatcher.kind, systemMatcher.fields);
      if (mErr) return mErr;
    }
    if (type === "message") {
      if (!messagePlatform) return "请选择平台";
      if (!messageTopic.trim()) return "请填写消息主题";
      const mErr = matcherIssue(messageMatcher.kind, messageMatcher.fields);
      if (mErr) return mErr;
    }
    return null;
  };

  const save = async () => {
    const issue = validate();
    if (issue) {
      setSaveError(issue);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const url = id ? `/api/events/${id}` : "/api/events";
      const method = id ? "PUT" : "POST";
      const r = await apiFetch(url, { method, body: JSON.stringify(buildPayload()) });
      if (r.ok) {
        const created = (await r.json()) as EventDTO;
        nav(id ? "/events" : `/events/${created.id}`);
        return;
      }
      let msg = await r.text();
      try {
        msg = (JSON.parse(msg) as { error?: string }).error ?? msg;
      } catch {
        // 非 JSON 响应保持原文
      }
      setSaveError(`保存失败：${msg}`);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!id) {
      setSaveError("先保存后再测试");
      return;
    }
    setTesting(true);
    setSaveError(null);
    try {
      const r = await apiFetch(`/api/events/${id}/test`, { method: "POST" });
      if (!r.ok) {
        setSaveError(`测试失败：HTTP ${r.status}`);
        setTestResult(null);
        return;
      }
      setTestResult((await r.json()) as TestResult);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(false);
    }
  };

  const openFiring = async (fid: string) => {
    if (expandedFiring === fid) {
      setExpandedFiring(null);
      return;
    }
    setExpandedFiring(fid);
    if (!firingRuns[fid] && id) {
      try {
        const r = await apiFetch(`/api/events/${id}/firings/${fid}`);
        if (r.ok) {
          const d = (await r.json()) as { runs?: RunDTO[] };
          setFiringRuns((m) => ({ ...m, [fid]: d.runs ?? [] }));
        }
      } catch {
        setFiringRuns((m) => ({ ...m, [fid]: [] }));
      }
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
        <div className="h-10 w-52 animate-pulse rounded bg-muted" />
        <div className="mt-5 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
        <PageHeader className="mb-4" title={id ? "编辑事件" : "新建事件"} />
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
          <span>事件加载失败：{loadError}</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" size={14} />
            重试
          </Button>
        </div>
      </div>
    );
  }

  const matcherOf =
    type === "schedule"
      ? scheduleMatcher
      : type === "call"
        ? callMatcher
        : type === "message"
          ? messageMatcher
          : systemMatcher;
  const setMatcherOf = (v: { kind: MatcherKind; fields: MatcherFields }) => {
    if (type === "schedule") setScheduleMatcher(v);
    else if (type === "call") setCallMatcher(v);
    else if (type === "message") setMessageMatcher(v);
    else setSystemMatcher(v);
  };

  return (
    <div className="mx-auto max-w-2xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        className="mb-5"
        title={id ? "编辑事件" : "新建事件"}
        description={
          type === "schedule"
            ? "到点触发；可带数据源做条件判定"
            : type === "call"
              ? "外部系统通过随机回调地址触发（GET/POST）"
              : isCompletion
                ? "上游执行完成时触发（可多选智能体或工作流）"
                : "订阅平台内部事件"
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => attempt(() => nav("/events"))}>
              取消
            </Button>
            {id && (
              <Button
                variant="secondary"
                onClick={() => void test()}
                disabled={testing || saving || type === "message"}
                title={
                  type === "message" ? "平台消息事件无固定数据源，真实触发见触发记录" : undefined
                }
              >
                {testing ? "测试中…" : "立即测试"}
              </Button>
            )}
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      />
      {saveError && (
        <div className="rounded-lg bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
          {saveError}
        </div>
      )}

      <FormSection id="event-sec-basic" no="1" title="基础信息">
        <FormField label="名称" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 每天早报 / 工单回调"
          />
        </FormField>
        <FormField label="类型">
          <Select value={type} onChange={(e) => setType(e.target.value as EventType)}>
            <option value="schedule">定时事件</option>
            <option value="call">调用事件</option>
            <option value="system">系统默认</option>
            <option value="message">平台消息</option>
          </Select>
        </FormField>
      </FormSection>

      <FormSection
        id="event-sec-source"
        no="2"
        title="触发配置"
        description={
          type === "schedule"
            ? "定时表达式；有条件定时再配数据源与匹配条件"
            : type === "call"
              ? "回调地址由平台生成（每事件独立随机路径），支持 GET 与 POST"
              : type === "message"
                ? "订阅钉钉群 @ 机器人等平台推送，命中后交给绑定的智能体处理（Teambition 即将支持）"
                : "选择要订阅的平台事件"
        }
      >
        {type === "schedule" ? (
          <>
            <FormField label="定时规则" required>
              <CronBuilder value={cron} onChange={(expr) => setCron(expr)} />
            </FormField>
            <FormField
              label="触发方式"
              hint="纯定时：到点即触发，上下文携带触发时间；有条件定时：抓取数据源并按条件判定"
            >
              <Select
                value={scheduleMode}
                onChange={(e) => setScheduleMode(e.target.value as "unconditional" | "conditional")}
              >
                <option value="unconditional">纯定时（无条件，到点触发）</option>
                <option value="conditional">有条件定时（抓取数据源 + 条件判定）</option>
              </Select>
            </FormField>
            {scheduleMode === "conditional" && (
              <>
                <FormField label="数据源">
                  <Select
                    value={sourceType}
                    onChange={(e) => setSourceType(e.target.value as "http" | "file")}
                  >
                    <option value="http">HTTP 请求</option>
                    <option value="file">文件读取</option>
                  </Select>
                </FormField>
                {sourceType === "http" ? (
                  <div className="grid gap-2.5 sm:grid-cols-[1fr_7rem]">
                    <FormField label="URL" required>
                      <Input
                        mono
                        value={httpUrl}
                        onChange={(e) => setHttpUrl(e.target.value)}
                        placeholder="https://..."
                      />
                    </FormField>
                    <FormField label="Method">
                      <Select value={httpMethod} onChange={(e) => setHttpMethod(e.target.value)}>
                        <option>GET</option>
                        <option>POST</option>
                        <option>PUT</option>
                      </Select>
                    </FormField>
                  </div>
                ) : (
                  <FormField label="文件路径" required hint="仅允许工作区内路径">
                    <Input
                      mono
                      value={filePath}
                      onChange={(e) => setFilePath(e.target.value)}
                      placeholder="data/report.json"
                    />
                  </FormField>
                )}
              </>
            )}
          </>
        ) : type === "call" ? (
          <>
            <FormField
              label="回调地址"
              hint={
                id
                  ? "外部系统调用此地址触发（保存后不变）；GET 查询串与 POST body {query,data} 都会进入上下文"
                  : "保存后由平台生成随机地址（每事件独立）"
              }
            >
              <Input
                mono
                readOnly
                value={callPath ? `${window.location.origin}${callPath}` : "（保存后生成）"}
              />
            </FormField>
            <FormField label="固定返回内容">
              <Input value={callResponse} onChange={(e) => setCallResponse(e.target.value)} />
            </FormField>
          </>
        ) : type === "message" ? (
          <>
            <FormField label="平台" hint="Teambition 随下一期开放">
              <Select
                value={messagePlatform}
                onChange={(e) => {
                  const p = e.target.value as "dingtalk" | "teambition";
                  setMessagePlatform(p);
                  setMessageTopic(p === "dingtalk" ? "robot.group" : "task.update");
                }}
              >
                <option value="dingtalk">钉钉（群 @ 机器人）</option>
                <option value="teambition" disabled>
                  Teambition（即将支持）
                </option>
              </Select>
            </FormField>
            <FormField label="消息主题" hint="钉钉群 @ 机器人固定为 robot.group">
              <Input mono readOnly value={messageTopic} />
            </FormField>
            <FormField
              label="限定群 ID（openConversationId）"
              hint="留空=所有群生效；群 ID 可在钉钉群设置或由触发记录里查看"
            >
              <Input
                mono
                value={msgConvId}
                onChange={(e) => setMsgConvId(e.target.value)}
                placeholder="留空=不限定"
              />
            </FormField>
            <FormField
              label="发起人白名单（staffId，每行一个）"
              hint="留空=群内所有成员 @ 机器人都可触发"
            >
              <textarea
                className="min-h-20 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
                value={msgAllowFrom}
                onChange={(e) => setMsgAllowFrom(e.target.value)}
                placeholder={"staffId1\nstaffId2"}
              />
            </FormField>
            {!msgAllowFrom.trim() && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                ⚠️ 未配置白名单：该群内<strong>任何成员</strong> @ 机器人都将触发本工作流
                {type === "message" ? "（以工作流配置的身份与权限执行，请确认风险）" : ""}。
              </div>
            )}
          </>
        ) : (
          <>
            <FormField
              label="平台事件"
              required
              hint={
                isCompletion
                  ? "上游执行完成时触发；按下方所选主体与时机过滤"
                  : "事件发生时把载荷 JSON 交给触发条件判定"
              }
            >
              <Select
                value={systemName}
                onChange={(e) => {
                  const prev = isCompletionEventName(systemName);
                  const next = isCompletionEventName(e.target.value);
                  if (prev !== next) setSubjects([]);
                  setSystemName(e.target.value);
                }}
              >
                {SYSTEM_EVENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
            {isCompletion && (
              <>
                <FormField
                  label={
                    systemName === "agent.execution.completed"
                      ? "智能体（可多选）"
                      : "工作流（可多选）"
                  }
                  required
                  hint="候选 = 我可使用（自有或被分享）；只有我名下的执行会触发本事件"
                >
                  {subjectOptions.length ? (
                    <div className="grid max-h-52 gap-1.5 overflow-y-auto sm:grid-cols-2">
                      {subjectOptions.map((o) => (
                        <label
                          key={o.id}
                          className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-muted/40"
                        >
                          <input
                            type="checkbox"
                            checked={subjects.includes(o.id)}
                            onChange={(e) =>
                              setSubjects((s) =>
                                e.target.checked ? [...s, o.id] : s.filter((x) => x !== o.id),
                              )
                            }
                          />
                          <span className="truncate">{o.name}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">暂无可选主体</p>
                  )}
                </FormField>
                <FormField label="触发时机" hint="上游以什么状态完成时触发">
                  <Select value={timing} onChange={(e) => setTiming(e.target.value)}>
                    <option value="all">全部（成功 / 失败 / 终止）</option>
                    <option value="success">仅成功时</option>
                    <option value="failed">仅失败时</option>
                    <option value="stopped">仅终止时</option>
                  </Select>
                </FormField>
              </>
            )}
          </>
        )}
      </FormSection>

      <FormSection
        id="event-sec-matcher"
        no="3"
        title="触发条件"
        description={
          isCompletion
            ? "完成事件按所选主体与触发时机过滤，无需匹配条件"
            : type === "schedule" && scheduleMode === "unconditional"
              ? "纯定时无需条件（到点即触发）"
              : "对事件上下文做匹配，命中才进入工作流"
        }
      >
        {isCompletion ? (
          <p className="text-sm text-muted-foreground">无需配置触发条件。</p>
        ) : type === "schedule" && scheduleMode === "unconditional" ? (
          <p className="text-sm text-muted-foreground">纯定时无需配置触发条件。</p>
        ) : (
          <>
            <FormField label="匹配方式">
              <Select
                value={matcherOf.kind}
                onChange={(e) => setMatcherOf({ kind: e.target.value as MatcherKind, fields: {} })}
              >
                {MATCHER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <MatcherFieldsEditor
              kind={matcherOf.kind}
              fields={matcherOf.fields}
              onChange={(fields) => setMatcherOf({ ...matcherOf, fields })}
            />
          </>
        )}
      </FormSection>

      {testResult && (
        <FormSection id="event-sec-test" no="4" title="测试结果">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">匹配结果</span>
            <Badge tone={testResult.matched ? "success" : "danger"}>
              {testResult.matched ? "命中" : "未命中"}
            </Badge>
            {testResult.error && <span className="text-destructive">错误：{testResult.error}</span>}
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs">
            {testResult.sourceOutput}
          </pre>
          {testResult.debug != null && (
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              {JSON.stringify(testResult.debug, null, 2)}
            </pre>
          )}
        </FormSection>
      )}

      {id && (
        <FormSection
          id="event-sec-firings"
          no="5"
          title="触发记录"
          description="每次触发的上下文留痕（永久保留）；点击展开查看上下文与本次执行的轮次"
        >
          {firings.length ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">时间</th>
                    <th className="px-3 py-2 font-medium">来源</th>
                    <th className="px-3 py-2 font-medium">扇出</th>
                    <th className="px-3 py-2 font-medium">上下文</th>
                  </tr>
                </thead>
                <tbody>
                  {firings.map((f) => (
                    <Fragment key={f.id}>
                      <tr
                        key={f.id}
                        className="cursor-pointer border-t border-border hover:bg-muted/40"
                        onClick={() => void openFiring(f.id)}
                      >
                        <td className="px-3 py-2">{new Date(f.firedAt).toLocaleString()}</td>
                        <td className="px-3 py-2">
                          <Badge tone="neutral">{SOURCE_LABEL[f.source] ?? f.source}</Badge>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {f.matchedWorkflowCount}
                        </td>
                        <td className="max-w-xs truncate px-3 py-2 text-muted-foreground">
                          {f.context}
                        </td>
                      </tr>
                      {expandedFiring === f.id && (
                        <tr key={`${f.id}-detail`} className="border-t border-border bg-muted/30">
                          <td colSpan={4} className="p-3">
                            <pre className="max-h-48 overflow-auto rounded-lg bg-card p-2.5 text-xs">
                              {f.context}
                            </pre>
                            <div className="mt-2 space-y-1">
                              {(firingRuns[f.id] ?? []).length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                  本次触发没有执行轮次
                                </p>
                              ) : (
                                (firingRuns[f.id] ?? []).map((run) => (
                                  <div
                                    key={run.id}
                                    className="flex items-center justify-between gap-2 text-xs"
                                  >
                                    <span className="text-muted-foreground">
                                      {workflowNames.get(run.workflowId) ??
                                        run.workflowId.slice(0, 8)}
                                    </span>
                                    <span className="flex items-center gap-2">
                                      <Badge tone={runStatusTone(run.status)}>
                                        {runStatusLabel(run.status)}
                                      </Badge>
                                      {run.error ? (
                                        <span className="text-destructive">{run.error}</span>
                                      ) : null}
                                      {run.conversationId ? (
                                        <a
                                          href={`/?conv=${run.conversationId}`}
                                          className="text-primary hover:underline"
                                        >
                                          会话
                                        </a>
                                      ) : null}
                                    </span>
                                  </div>
                                ))
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">还没有触发记录</p>
          )}
        </FormSection>
      )}
      {dialog}
    </div>
  );
}

function MatcherFieldsEditor(props: {
  kind: MatcherKind;
  fields: MatcherFields;
  onChange: (fields: MatcherFields) => void;
}) {
  const { kind, fields, onChange } = props;
  if (kind === "statusEq") {
    return (
      <FormField label="状态码">
        <Input
          type="number"
          placeholder="200"
          value={fields.value ?? ""}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      </FormField>
    );
  }
  if (kind === "bodyContains") {
    return (
      <FormField label="关键词">
        <Input
          placeholder="keyword"
          value={fields.keyword ?? ""}
          onChange={(e) => onChange({ keyword: e.target.value })}
        />
      </FormField>
    );
  }
  if (kind === "bodyRegex") {
    return (
      <FormField label="正则表达式">
        <Input
          mono
          placeholder="v\d+"
          value={fields.pattern ?? ""}
          onChange={(e) => onChange({ pattern: e.target.value })}
        />
      </FormField>
    );
  }
  if (kind === "jsonPathEq" || kind === "jsonPathGt") {
    return (
      <div className="grid gap-2.5 sm:grid-cols-2">
        <FormField label="JSON Path">
          <Input
            mono
            placeholder="$.count"
            value={fields.path ?? ""}
            onChange={(e) => onChange({ ...fields, path: e.target.value })}
          />
        </FormField>
        <FormField label="比较值">
          <Input
            type={kind === "jsonPathGt" ? "number" : "text"}
            placeholder={kind === "jsonPathGt" ? "10" : "value"}
            value={fields.value ?? ""}
            onChange={(e) => onChange({ ...fields, value: e.target.value })}
          />
        </FormField>
      </div>
    );
  }
  if (kind === "bodyFieldEq") {
    return (
      <div className="grid gap-2.5 sm:grid-cols-2">
        <FormField label="顶层字段名">
          <Input
            placeholder="type"
            value={fields.field ?? ""}
            onChange={(e) => onChange({ ...fields, field: e.target.value })}
          />
        </FormField>
        <FormField label="等于值">
          <Input
            placeholder="issue"
            value={fields.value ?? ""}
            onChange={(e) => onChange({ ...fields, value: e.target.value })}
          />
        </FormField>
      </div>
    );
  }
  if (kind === "headerEq") {
    return (
      <div className="grid gap-2.5 sm:grid-cols-2">
        <FormField label="Header 名">
          <Input
            mono
            placeholder="x-signature"
            value={fields.header ?? ""}
            onChange={(e) => onChange({ ...fields, header: e.target.value })}
          />
        </FormField>
        <FormField label="等于值">
          <Input
            placeholder="value"
            value={fields.value ?? ""}
            onChange={(e) => onChange({ ...fields, value: e.target.value })}
          />
        </FormField>
      </div>
    );
  }
  return null;
}
