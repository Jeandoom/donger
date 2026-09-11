import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import {
  type ConnectorDTO,
  type ConnectorInput,
  type ConnectorTestResult,
  createConnector,
  deleteConnector,
  fetchConnectors,
  testConnector,
  updateConnector,
} from "../lib/connectors";
import { fetchCredentialTemplates } from "../lib/skills";

/** 表单状态：鉴权三档（无 / Bearer 引用凭证 / 自定义 KV）；Bearer 档生成 {{credential:*}} 引用头 */
interface Draft {
  name: string;
  description: string;
  url: string;
  authMode: "none" | "bearer" | "custom";
  bearerCode: string;
  rows: Array<{ id: string; key: string; value: string }>;
  shareScope: "private" | "global";
  enabled: boolean;
}

const emptyDraft: Draft = {
  name: "",
  description: "",
  url: "",
  authMode: "none",
  bearerCode: "",
  rows: [],
  shareScope: "private",
  enabled: true,
};

/** 从既有 headers 反推表单形态（Bearer 引用 / 空 / 自定义 KV） */
function draftFromConnector(c: ConnectorDTO): Draft {
  const entries = Object.entries(c.headers);
  if (entries.length === 0)
    return {
      ...emptyDraft,
      name: c.name,
      description: c.description ?? "",
      url: c.url,
      shareScope: c.shareScope,
      enabled: c.enabled,
    };
  const first = entries[0];
  if (
    entries.length === 1 &&
    first?.[0] === "Authorization" &&
    /^Bearer \{\{credential:[A-Za-z0-9_-]+\}\}$/.test(first[1] ?? "")
  ) {
    return {
      ...emptyDraft,
      name: c.name,
      description: c.description ?? "",
      url: c.url,
      authMode: "bearer",
      bearerCode: (first[1] ?? "").replace(/^Bearer \{\{credential:|\}\}$/g, ""),
      shareScope: c.shareScope,
      enabled: c.enabled,
    };
  }
  return {
    ...emptyDraft,
    name: c.name,
    description: c.description ?? "",
    url: c.url,
    authMode: "custom",
    rows: entries.map(([key, value]) => ({ id: crypto.randomUUID(), key, value })),
    shareScope: c.shareScope,
    enabled: c.enabled,
  };
}

function headersOf(d: Draft): Record<string, string> {
  if (d.authMode === "bearer" && d.bearerCode.trim()) {
    return { Authorization: `Bearer {{credential:${d.bearerCode.trim()}}}` };
  }
  if (d.authMode === "custom") {
    return Object.fromEntries(
      d.rows.filter((r) => r.key.trim() !== "").map((r) => [r.key.trim(), r.value]),
    );
  }
  return {};
}

export function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<ConnectorDTO | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConnectorDTO | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [credentialOptions, setCredentialOptions] = useState<Array<{ code: string; name: string }>>(
    [],
  );

  const reload = useCallback(async () => {
    try {
      setConnectors(await fetchConnectors());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    fetchCredentialTemplates()
      .then((templates) =>
        setCredentialOptions(templates.map((t) => ({ code: t.code, name: t.name }))),
      )
      .catch(() => {});
  }, [reload]);

  const mine = connectors.filter((c) => c.createdByMe);
  const global = connectors.filter((c) => !c.createdByMe && c.shareScope === "global");

  const save = async () => {
    if (!draft.name.trim() || !draft.url.trim()) return;
    setBusy(true);
    try {
      const input: ConnectorInput = {
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        url: draft.url.trim(),
        headers: headersOf(draft),
        enabled: draft.enabled,
        shareScope: draft.shareScope,
      };
      if (editing) {
        await updateConnector(editing.id, input);
      } else {
        await createConnector(input);
      }
      setDraft(emptyDraft);
      setEditing(null);
      await reload();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!draft.url.trim()) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      setTestResult(await testConnector({ url: draft.url.trim(), headers: headersOf(draft) }));
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTestBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteConnector(confirmDelete.id);
      setConfirmDelete(null);
      await reload();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const toggleEnabled = async (c: ConnectorDTO) => {
    try {
      await updateConnector(c.id, {
        name: c.name,
        description: c.description,
        url: c.url,
        headers: c.headers,
        enabled: !c.enabled,
        shareScope: c.shareScope,
      });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const renderCard = (c: ConnectorDTO) => (
    <div key={c.id} className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{c.name}</span>
        <span className="rounded bg-blue-500/10 px-1 text-xs text-blue-600">HTTP</span>
        {c.shareScope === "global" && (
          <span className="rounded bg-emerald-500/10 px-1 text-xs text-emerald-600">全局</span>
        )}
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={c.enabled} onChange={() => void toggleEnabled(c)} />
          启用
        </label>
      </div>
      <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{c.url}</div>
      {c.description && <div className="text-xs text-muted-foreground">{c.description}</div>}
      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
        <span>被 {c.usedBy} 个智能体引用</span>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={() => {
            setEditing(c);
            setDraft(draftFromConnector(c));
            setTestResult(null);
            setError(null);
          }}
        >
          编辑
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => {
            setConfirmDelete(c);
            setDeleteError(null);
          }}
        >
          删除
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto p-4">
      <h1 className="mb-4 text-lg font-semibold">连接器</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        连接器是 HTTP MCP 服务注册：配置一次，多个智能体勾选复用。鉴权头支持引用
        <span className="font-medium">凭证模板</span>（{"{{credential:code}}"}
        ）——共享连接器执行时使用
        <span className="font-medium">访问者自己的</span>凭证值。
      </p>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 新建 / 编辑表单 */}
      <div className="mb-4 rounded-lg border border-border p-3">
        <div className="mb-2 text-sm font-medium">
          {editing ? `编辑连接器 ${editing.name}` : "新建连接器"}
        </div>
        <div className="mb-2 flex flex-wrap gap-2">
          <input
            className="w-48 rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="名称*"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <input
            className="w-64 rounded-md border border-border px-2 py-1.5 text-sm"
            placeholder="说明（可选）"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
          <input
            className="w-80 rounded-md border border-border px-2 py-1.5 font-mono text-sm"
            placeholder="URL*（https://…/mcp）"
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
          />
          <select
            className="rounded-md border border-border px-2 py-1.5 text-sm"
            value={draft.shareScope}
            onChange={(e) =>
              setDraft((d) => ({ ...d, shareScope: e.target.value as "private" | "global" }))
            }
          >
            <option value="private">仅我可见</option>
            <option value="global">全局共享</option>
          </select>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">鉴权</span>
          {(["none", "bearer", "custom"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1 text-sm">
              <input
                type="radio"
                checked={draft.authMode === m}
                onChange={() => setDraft((d) => ({ ...d, authMode: m }))}
              />
              {m === "none" ? "无" : m === "bearer" ? "Bearer Token" : "自定义头部"}
            </label>
          ))}
          {draft.authMode === "bearer" && (
            <select
              className="rounded-md border border-border px-2 py-1.5 text-sm"
              value={draft.bearerCode}
              onChange={(e) => setDraft((d) => ({ ...d, bearerCode: e.target.value }))}
            >
              <option value="">选择凭证模板…</option>
              {credentialOptions.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}（{t.code}）
                </option>
              ))}
            </select>
          )}
          {draft.authMode === "bearer" && draft.bearerCode && (
            <span className="font-mono text-xs text-muted-foreground">
              Authorization: Bearer {"{{credential:"}
              {draft.bearerCode}
              {"}}"}
            </span>
          )}
        </div>
        {draft.authMode === "custom" && (
          <div className="mb-2 space-y-1">
            {draft.rows.map((row) => (
              <div key={row.id} className="flex gap-2">
                <input
                  className="w-48 rounded-md border border-border px-2 py-1 font-mono text-sm"
                  placeholder="Header 名（如 X-Api-Key）"
                  value={row.key}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      rows: d.rows.map((r) =>
                        r.id === row.id ? { ...r, key: e.target.value } : r,
                      ),
                    }))
                  }
                />
                <input
                  className="flex-1 rounded-md border border-border px-2 py-1 font-mono text-sm"
                  placeholder="值（支持 {{credential:code}} 引用；•••• = 保留原值）"
                  value={row.value}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      rows: d.rows.map((r) =>
                        r.id === row.id ? { ...r, value: e.target.value } : r,
                      ),
                    }))
                  }
                />
                <button
                  type="button"
                  className="rounded border px-2 text-xs hover:bg-accent"
                  onClick={() =>
                    setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== row.id) }))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs hover:bg-accent"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  rows: [...d.rows, { id: crypto.randomUUID(), key: "", value: "" }],
                }))
              }
            >
              ＋ 添加头部
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy || !draft.name.trim() || !draft.url.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "保存中…" : editing ? "保存修改" : "创建"}
          </button>
          {editing && (
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                setEditing(null);
                setDraft(emptyDraft);
                setTestResult(null);
              }}
            >
              取消编辑
            </button>
          )}
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            disabled={testBusy || !draft.url.trim()}
            onClick={() => void runTest()}
          >
            {testBusy ? "测试中…" : "▶ 测试连接"}
          </button>
          {testResult &&
            (testResult.ok ? (
              <span className="text-xs text-emerald-600">
                ✓ 连接成功 · {testResult.latencyMs}ms · {testResult.toolCount} 个工具
                {testResult.tools && testResult.tools.length > 0
                  ? `（${testResult.tools.slice(0, 5).join(", ")}${(testResult.tools.length ?? 0) > 5 ? "…" : ""}）`
                  : ""}
              </span>
            ) : (
              <span className="text-xs text-destructive">✕ {testResult.error}</span>
            ))}
        </div>
      </div>

      {/* 双区列表 */}
      <div className="mb-2 text-sm font-medium">我的连接器</div>
      {mine.length === 0 ? (
        <div className="mb-4 text-sm text-muted-foreground">暂无连接器，用上方表单创建。</div>
      ) : (
        <div className="mb-4 space-y-2">{mine.map(renderCard)}</div>
      )}

      <div className="mb-2 text-sm font-medium">全局连接器（人人可用；仅创建人可管理）</div>
      {global.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无他人共享的全局连接器。</div>
      ) : (
        <div className="space-y-2">{global.map(renderCard)}</div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`删除连接器 ${confirmDelete?.name ?? ""}`}
        description="删除后引用它的智能体将不再获得该 MCP 的工具。被引用时删除会被拒绝。"
        confirmText="删除"
        destructive
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void remove()}
        onCancel={() => {
          setConfirmDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
