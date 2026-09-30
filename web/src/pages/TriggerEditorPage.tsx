import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useDirtyGuard } from "../components/ui/dirty-guard";
import { FormField, FormSection } from "../components/ui/form-section";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { apiFetch } from "../lib/auth";

type MatcherKind =
  | "always"
  | "statusEq"
  | "bodyContains"
  | "bodyRegex"
  | "jsonPathEq"
  | "jsonPathGt"
  | "bodyFieldEq"
  | "headerEq";

/** matcher 字段值统一以 string 持有；buildPayload 时按 kind 转 number */
type MatcherFields = Record<string, string>;

interface TriggerDTO {
  id: string;
  name: string;
  type: "scheduler" | "hook" | "event" | "git";
  git?: {
    provider: "github" | "gitee" | "jihulab";
    repoUrl: string;
    branch: string;
    credentialCode?: string;
  };
  scheduler?: {
    cron: string;
    source: { type: "http"; url: string; method: string } | { type: "file"; path: string };
    matcher: { kind: MatcherKind } & MatcherFields;
  };
  hook?: {
    path: string;
    responseStatus: number;
    responseBody: string;
    matcher: { kind: MatcherKind } & MatcherFields;
  };
  event?: {
    name: string;
    matcher: { kind: MatcherKind } & MatcherFields;
  };
}

interface TestResult {
  sourceOutput: string;
  matched: boolean;
  debug?: string;
  error?: string;
}

/** 与后端 EVENT_TRIGGER_NAMES 注册表两端语义一致（spec 2026-09-28-event-trigger-feedback-design） */
const EVENT_NAME_OPTIONS: { value: string; label: string }[] = [
  { value: "feedback.created", label: "新反馈提交" },
];

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

export function TriggerEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<"scheduler" | "hook" | "event" | "git">("scheduler");
  const [gitProvider, setGitProvider] = useState<"github" | "gitee" | "jihulab">("gitee");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("master");
  const [gitCredentialCode, setGitCredentialCode] = useState("");
  const [gitCreds, setGitCreds] = useState<Array<{ code: string; name: string }>>([]);
  const [eventName, setEventName] = useState("feedback.created");
  const [cron, setCron] = useState("0 * * * *");
  const [sourceType, setSourceType] = useState<"http" | "file">("http");
  const [httpUrl, setHttpUrl] = useState("");
  const [httpMethod, setHttpMethod] = useState("GET");
  const [filePath, setFilePath] = useState("");
  const [hookPath, setHookPath] = useState("/hooks/");
  const [hookResponse, setHookResponse] = useState("success");
  const [matcherKind, setMatcherKind] = useState<MatcherKind>("always");
  const [matcher, setMatcher] = useState<MatcherFields>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!id);

  /** 全部受控字段的快照；编辑态加载完成后钉为基线，之后与基线比较得 dirty */
  const snapshot = JSON.stringify({
    name,
    type,
    eventName,
    cron,
    sourceType,
    httpUrl,
    httpMethod,
    filePath,
    hookPath,
    hookResponse,
    gitProvider,
    gitRepoUrl,
    gitBranch,
    gitCredentialCode,
    matcherKind,
    matcher,
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
      const r = await apiFetch(`/api/triggers/${id}`);
      if (!r.ok) throw new Error(`加载失败（HTTP ${r.status}）`);
      const t = (await r.json()) as TriggerDTO;
      setName(t.name);
      setType(t.type);
      if (t.scheduler) {
        setCron(t.scheduler.cron);
        setSourceType(t.scheduler.source.type);
        if (t.scheduler.source.type === "http") {
          setHttpUrl(t.scheduler.source.url);
          setHttpMethod(t.scheduler.source.method);
        } else {
          setFilePath(t.scheduler.source.path);
        }
        const { kind, ...rest } = t.scheduler.matcher;
        setMatcherKind(kind);
        // number 字段反序列化为 string 以便 input 受控
        setMatcher(
          Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v == null ? "" : String(v)])),
        );
      }
      if (t.hook) {
        setHookPath(t.hook.path);
        setHookResponse(t.hook.responseBody);
        const { kind, ...rest } = t.hook.matcher;
        setMatcherKind(kind);
        setMatcher(
          Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v == null ? "" : String(v)])),
        );
      }
      if (t.git) {
        setGitProvider(t.git.provider);
        setGitRepoUrl(t.git.repoUrl);
        setGitBranch(t.git.branch);
        setGitCredentialCode(t.git.credentialCode ?? "");
      }
      if (t.event) {
        setEventName(t.event.name);
        const { kind, ...rest } = t.event.matcher;
        setMatcherKind(kind);
        setMatcher(
          Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v == null ? "" : String(v)])),
        );
      }
      setLoaded(true);
      pristineRef.current = null; // 下一个 effect 以加载后的快照钉基线
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // git 凭证模板下拉（git 触发类型可用；拉一次）
  useEffect(() => {
    if (type !== "git" || gitCreds.length) return;
    apiFetch("/api/credential-templates")
      .then(
        (r) =>
          r.json() as Promise<{ templates?: Array<{ code: string; name: string; kind: string }> }>,
      )
      .then((d) => setGitCreds((d.templates ?? []).filter((t) => t.kind === "git")))
      .catch(() => setGitCreds([]));
  }, [type, gitCreds.length]);

  const buildPayload = () => {
    const m = buildMatcher(matcherKind, matcher);
    if (type === "scheduler") {
      return {
        name,
        type,
        scheduler: {
          cron,
          source:
            sourceType === "http"
              ? { type: "http", url: httpUrl, method: httpMethod }
              : { type: "file", path: filePath },
          matcher: m,
        },
      };
    }
    if (type === "event") {
      return {
        name,
        type,
        event: { name: eventName, matcher: m },
      };
    }
    if (type === "git") {
      return {
        name,
        type,
        git: {
          provider: gitProvider,
          repoUrl: gitRepoUrl.trim(),
          branch: gitBranch.trim(),
          ...(gitCredentialCode ? { credentialCode: gitCredentialCode } : {}),
        },
      };
    }
    return {
      name,
      type,
      hook: {
        path: hookPath,
        responseStatus: 200,
        responseBody: hookResponse,
        matcher: m,
      },
    };
  };

  /** 保存前客户端校验；返回首个错误的提示，null = 通过 */
  const validate = (): string | null => {
    if (!name.trim()) return "请填写名称";
    if (type === "scheduler") {
      if (!cron.trim()) return "请填写 Cron 表达式";
      if (sourceType === "http" && !/^https?:\/\/\S+/.test(httpUrl.trim())) {
        return "数据源为 HTTP 时请填写合法 URL（http/https）";
      }
      if (sourceType === "file" && !filePath.trim()) return "请填写文件路径";
    } else if (type === "hook" && !hookPath.trim().startsWith("/")) {
      return "回调路径需以 / 开头";
    } else if (type === "git") {
      if (!/^https:\/\/\S+\.git$|^https:\/\/\S+$/.test(gitRepoUrl.trim())) {
        return "请填写仓库 HTTPS 地址（如 https://gitee.com/org/repo.git）";
      }
      if (!gitBranch.trim()) return "请填写分支名";
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
      const url = id ? `/api/triggers/${id}` : "/api/triggers";
      const method = id ? "PUT" : "POST";
      const r = await apiFetch(url, { method, body: JSON.stringify(buildPayload()) });
      if (r.ok) {
        nav("/triggers");
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
      const r = await apiFetch(`/api/triggers/${id}/test`, { method: "POST" });
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
        <PageHeader className="mb-4" title={id ? "编辑触发器" : "新建触发器"} />
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
          <span>触发器加载失败：{loadError}</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" size={14} />
            重试
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        className="mb-5"
        title={id ? "编辑触发器" : "新建触发器"}
        description="定时抓取、外部回调或平台事件，配合工作流驱动智能体任务"
        actions={
          <>
            <Button variant="secondary" onClick={() => attempt(() => nav("/triggers"))}>
              取消
            </Button>
            {id && (
              <Button variant="secondary" onClick={() => void test()} disabled={testing || saving}>
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

      <FormSection id="trigger-sec-basic" no="1" title="基础信息">
        <FormField label="名称" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 每小时抓取 issue 列表"
          />
        </FormField>
        <FormField label="类型">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as "scheduler" | "hook" | "event" | "git")}
          >
            <option value="scheduler">定时（scheduler）</option>
            <option value="hook">回调（hook）</option>
            <option value="event">事件（event）</option>
            <option value="git">代码提交（git）</option>
          </Select>
        </FormField>
      </FormSection>

      <FormSection
        id="trigger-sec-source"
        no="2"
        title="触发源"
        description={
          type === "scheduler"
            ? "定时表达式与数据来源"
            : type === "event"
              ? "订阅平台内部事件（仅管理员可用）"
              : type === "git"
                ? "平台出站轮询分支 HEAD（默认 2 分钟），出现新提交触发一次（无需 webhook）"
                : "外部系统回调入口"
        }
      >
        {type === "scheduler" ? (
          <>
            <FormField
              label="Cron 表达式"
              required
              hint="示例：每小时 0 * * * *；每天 9 点 0 9 * * *"
            >
              <Input mono value={cron} onChange={(e) => setCron(e.target.value)} />
            </FormField>
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
              <FormField label="文件路径" required>
                <Input
                  mono
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder="/path/to/file"
                />
              </FormField>
            )}
          </>
        ) : type === "git" ? (
          <>
            <FormField label="代码平台">
              <Select
                value={gitProvider}
                onChange={(e) => setGitProvider(e.target.value as "github" | "gitee" | "jihulab")}
              >
                <option value="gitee">gitee</option>
                <option value="jihulab">jihulab / GitLab</option>
                <option value="github">github</option>
              </Select>
            </FormField>
            <FormField label="仓库 HTTPS 地址" required>
              <Input
                mono
                value={gitRepoUrl}
                onChange={(e) => setGitRepoUrl(e.target.value)}
                placeholder="https://gitee.com/org/repo.git"
              />
            </FormField>
            <FormField label="分支" required>
              <Input mono value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} />
            </FormField>
            <FormField
              label="git 凭证"
              hint="私有仓库必填（凭证页的 git PAT 模板）；公共仓库可不选"
            >
              <Select
                value={gitCredentialCode}
                onChange={(e) => setGitCredentialCode(e.target.value)}
              >
                <option value="">（公共仓库，匿名）</option>
                {gitCreds.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}（{c.code}）
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        ) : type === "hook" ? (
          <>
            <FormField
              label="回调路径"
              required
              hint={`外部访问：${typeof window !== "undefined" ? window.location.origin : ""}${hookPath}`}
            >
              <Input mono value={hookPath} onChange={(e) => setHookPath(e.target.value)} />
            </FormField>
            <FormField label="固定返回内容">
              <Input value={hookResponse} onChange={(e) => setHookResponse(e.target.value)} />
            </FormField>
          </>
        ) : (
          <FormField
            label="事件"
            required
            hint="事件发生时把载荷 JSON 交给触发条件判定；循环忙时自动排队不丢"
          >
            <Select value={eventName} onChange={(e) => setEventName(e.target.value)}>
              {EVENT_NAME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>
        )}
      </FormSection>

      {type !== "git" ? (
        <FormSection
          id="trigger-sec-matcher"
          no="3"
          title="触发条件"
          description="对数据源输出做匹配，命中才进入工作流"
        >
          <FormField label="匹配方式">
            <Select
              value={matcherKind}
              onChange={(e) => {
                setMatcherKind(e.target.value as MatcherKind);
                setMatcher({});
              }}
            >
              {MATCHER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>
          {matcherKind === "statusEq" && (
            <FormField label="状态码">
              <Input
                type="number"
                placeholder="200"
                value={matcher.value ?? ""}
                onChange={(e) => setMatcher({ value: e.target.value })}
              />
            </FormField>
          )}
          {matcherKind === "bodyContains" && (
            <FormField label="关键词">
              <Input
                placeholder="keyword"
                value={matcher.keyword ?? ""}
                onChange={(e) => setMatcher({ keyword: e.target.value })}
              />
            </FormField>
          )}
          {matcherKind === "bodyRegex" && (
            <FormField label="正则表达式">
              <Input
                mono
                placeholder="v\d+"
                value={matcher.pattern ?? ""}
                onChange={(e) => setMatcher({ pattern: e.target.value })}
              />
            </FormField>
          )}
          {(matcherKind === "jsonPathEq" || matcherKind === "jsonPathGt") && (
            <div className="grid gap-2.5 sm:grid-cols-2">
              <FormField label="JSON Path">
                <Input
                  mono
                  placeholder="$.count"
                  value={matcher.path ?? ""}
                  onChange={(e) => setMatcher((m) => ({ ...m, path: e.target.value }))}
                />
              </FormField>
              <FormField label="比较值">
                <Input
                  type={matcherKind === "jsonPathGt" ? "number" : "text"}
                  placeholder={matcherKind === "jsonPathGt" ? "10" : "value"}
                  value={matcher.value ?? ""}
                  onChange={(e) => setMatcher((m) => ({ ...m, value: e.target.value }))}
                />
              </FormField>
            </div>
          )}
          {matcherKind === "bodyFieldEq" && (
            <div className="grid gap-2.5 sm:grid-cols-2">
              <FormField label="顶层字段名">
                <Input
                  placeholder="type"
                  value={matcher.field ?? ""}
                  onChange={(e) => setMatcher((m) => ({ ...m, field: e.target.value }))}
                />
              </FormField>
              <FormField label="等于值">
                <Input
                  placeholder="issue"
                  value={matcher.value ?? ""}
                  onChange={(e) => setMatcher((m) => ({ ...m, value: e.target.value }))}
                />
              </FormField>
            </div>
          )}
          {matcherKind === "headerEq" && (
            <div className="grid gap-2.5 sm:grid-cols-2">
              <FormField label="Header 名">
                <Input
                  mono
                  placeholder="x-signature"
                  value={matcher.header ?? ""}
                  onChange={(e) => setMatcher((m) => ({ ...m, header: e.target.value }))}
                />
              </FormField>
              <FormField label="等于值">
                <Input
                  placeholder="value"
                  value={matcher.value ?? ""}
                  onChange={(e) => setMatcher((m) => ({ ...m, value: e.target.value }))}
                />
              </FormField>
            </div>
          )}
        </FormSection>
      ) : null}

      {testResult && (
        <FormSection id="trigger-sec-test" no="4" title="测试结果">
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
      {dialog}
    </div>
  );
}

/** 把 string 字段按 matcherKind 转成后端期望的 zod 输入 */
function buildMatcher(kind: MatcherKind, m: MatcherFields): unknown {
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
