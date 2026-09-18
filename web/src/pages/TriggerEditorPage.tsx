import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/page-header";
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
  type: "scheduler" | "hook";
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
}

interface TestResult {
  sourceOutput: string;
  matched: boolean;
  debug?: string;
  error?: string;
}

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
  const [type, setType] = useState<"scheduler" | "hook">("scheduler");
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiFetch(`/api/triggers/${id}`)
      .then((r) => r.json() as Promise<TriggerDTO>)
      .then((t) => {
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
            Object.fromEntries(
              Object.entries(rest).map(([k, v]) => [k, v == null ? "" : String(v)]),
            ),
          );
        }
        if (t.hook) {
          setHookPath(t.hook.path);
          setHookResponse(t.hook.responseBody);
          const { kind, ...rest } = t.hook.matcher;
          setMatcherKind(kind);
          setMatcher(
            Object.fromEntries(
              Object.entries(rest).map(([k, v]) => [k, v == null ? "" : String(v)]),
            ),
          );
        }
      })
      .catch(() => {});
  }, [id]);

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

  const save = async () => {
    setLoading(true);
    setSaveError(null);
    try {
      const url = id ? `/api/triggers/${id}` : "/api/triggers";
      const method = id ? "PUT" : "POST";
      const r = await apiFetch(url, { method, body: JSON.stringify(buildPayload()) });
      if (r.ok) nav("/triggers");
      else setSaveError(await r.text());
    } finally {
      setLoading(false);
    }
  };

  const test = async () => {
    if (!id) {
      setSaveError("先保存后再测试");
      return;
    }
    const r = await apiFetch(`/api/triggers/${id}/test`, { method: "POST" });
    setTestResult((await r.json()) as TestResult);
  };

  return (
    <div className="mx-auto max-w-2xl flex-1 overflow-y-auto p-7">
      <PageHeader className="mb-4" title={id ? "编辑触发器" : "新建触发器"} />
      {saveError ? (
        <div className="mb-3 rounded-lg bg-destructive-soft px-4 py-2.5 text-sm text-destructive">
          {saveError}
        </div>
      ) : null}
      <label className="mb-2 block">
        名称
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
      </label>
      <label className="mb-2 block">
        类型
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "scheduler" | "hook")}
          className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
        >
          <option value="scheduler">定时（scheduler）</option>
          <option value="hook">回调（hook）</option>
        </select>
      </label>
      {type === "scheduler" && (
        <div className="mb-3">
          <label className="mb-2 block">
            Cron 表达式
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none font-mono"
            />
          </label>
          <small className="text-muted-foreground">
            示例：每小时 <code>0 * * * *</code>；每天 9 点 <code>0 9 * * *</code>
          </small>
          <label className="mt-2 mb-2 block">
            数据源
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as "http" | "file")}
              className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
            >
              <option value="http">HTTP 请求</option>
              <option value="file">文件读取</option>
            </select>
          </label>
          {sourceType === "http" ? (
            <>
              <input
                value={httpUrl}
                onChange={(e) => setHttpUrl(e.target.value)}
                placeholder="https://..."
                className="mb-2 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
              <select
                value={httpMethod}
                onChange={(e) => setHttpMethod(e.target.value)}
                className="mb-2 rounded border px-2 py-1"
              >
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
              </select>
            </>
          ) : (
            <input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="/path/to/file"
              className="mb-2 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          )}
        </div>
      )}
      {type === "hook" && (
        <div className="mb-3">
          <label className="mb-2 block">
            回调路径
            <input
              value={hookPath}
              onChange={(e) => setHookPath(e.target.value)}
              className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none font-mono"
            />
          </label>
          <small className="text-muted-foreground">
            外部访问：{typeof window !== "undefined" ? window.location.origin : ""}
            {hookPath}
          </small>
          <label className="mt-2 mb-2 block">
            固定返回内容
            <input
              value={hookResponse}
              onChange={(e) => setHookResponse(e.target.value)}
              className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </label>
        </div>
      )}
      <fieldset className="mb-3 rounded border p-3">
        <legend className="px-1 text-sm">触发条件</legend>
        <select
          value={matcherKind}
          onChange={(e) => {
            setMatcherKind(e.target.value as MatcherKind);
            setMatcher({});
          }}
          className="mb-2 rounded border px-2 py-1"
        >
          {MATCHER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {matcherKind === "statusEq" && (
          <input
            type="number"
            placeholder="200"
            value={matcher.value ?? ""}
            onChange={(e) => setMatcher({ value: e.target.value })}
            className="rounded border px-2 py-1"
          />
        )}
        {matcherKind === "bodyContains" && (
          <input
            placeholder="keyword"
            value={matcher.keyword ?? ""}
            onChange={(e) => setMatcher({ keyword: e.target.value })}
            className="rounded border px-2 py-1"
          />
        )}
        {matcherKind === "bodyRegex" && (
          <input
            placeholder="v\d+"
            value={matcher.pattern ?? ""}
            onChange={(e) => setMatcher({ pattern: e.target.value })}
            className="rounded border px-2 py-1 font-mono"
          />
        )}
        {(matcherKind === "jsonPathEq" || matcherKind === "jsonPathGt") && (
          <>
            <input
              placeholder="$.count"
              value={matcher.path ?? ""}
              onChange={(e) => setMatcher((m) => ({ ...m, path: e.target.value }))}
              className="mb-2 block rounded border px-2 py-1"
            />
            <input
              type={matcherKind === "jsonPathGt" ? "number" : "text"}
              placeholder={matcherKind === "jsonPathGt" ? "10" : "value"}
              value={matcher.value ?? ""}
              onChange={(e) => setMatcher((m) => ({ ...m, value: e.target.value }))}
              className="rounded border px-2 py-1"
            />
          </>
        )}
        {matcherKind === "bodyFieldEq" && (
          <>
            <input
              placeholder="type"
              value={matcher.field ?? ""}
              onChange={(e) => setMatcher((m) => ({ ...m, field: e.target.value }))}
              className="mb-2 block rounded border px-2 py-1"
            />
            <input
              placeholder="issue"
              value={matcher.value ?? ""}
              onChange={(e) => setMatcher((m) => ({ ...m, value: e.target.value }))}
              className="rounded border px-2 py-1"
            />
          </>
        )}
        {matcherKind === "headerEq" && (
          <>
            <input
              placeholder="x-signature"
              value={matcher.header ?? ""}
              onChange={(e) => setMatcher((m) => ({ ...m, header: e.target.value }))}
              className="mb-2 block rounded border px-2 py-1"
            />
            <input
              placeholder="value"
              value={matcher.value ?? ""}
              onChange={(e) => setMatcher((m) => ({ ...m, value: e.target.value }))}
              className="rounded border px-2 py-1"
            />
          </>
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button type="button" onClick={save} disabled={loading}>
          保存
        </Button>
        {id && (
          <Button type="button" variant="outline" onClick={test}>
            立即测试
          </Button>
        )}
      </div>
      {testResult && (
        <div className="mt-4 rounded border p-3">
          <div>
            matched:{" "}
            <span className={testResult.matched ? "text-green-600" : "text-destructive"}>
              {String(testResult.matched)}
            </span>
          </div>
          {testResult.error && <div className="text-destructive">error: {testResult.error}</div>}
          <pre className="mt-2 max-h-40 overflow-auto bg-muted p-2 text-xs">
            {testResult.sourceOutput}
          </pre>
          {testResult.debug != null && (
            <pre className="mt-2 text-xs">{JSON.stringify(testResult.debug, null, 2)}</pre>
          )}
        </div>
      )}
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
