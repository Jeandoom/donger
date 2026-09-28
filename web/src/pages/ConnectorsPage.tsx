import { Play, Plus, Share2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { DialogShell } from "../components/ui/dialog-shell";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Segmented } from "../components/ui/segmented";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import {
  type ConnectorDTO,
  type ConnectorInput,
  type ConnectorTestResult,
  type ConnectorType,
  createConnector,
  deleteConnector,
  fetchConnectors,
  testConnector,
  updateConnector,
} from "../lib/connectors";
import { fetchCredentialTemplates } from "../lib/skills";

/** 表单状态：类型（MCP 服务 / HTTP 接口）+ 鉴权三档（无 / Bearer 引用凭证 / 自定义 KV）+ 代理认证 */
interface Draft {
  type: ConnectorType;
  name: string;
  description: string;
  url: string;
  authMode: "none" | "bearer" | "custom";
  bearerCode: string;
  rows: Array<{ id: string; key: string; value: string }>;
  /** 代理认证（仅 type=http 出网通道消费）：none=静态头；另两档需选凭证模板 */
  proxyAuthStyle: "none" | "basic-crumb" | "token-login";
  proxyAuthCredential: string;
  enabled: boolean;
}

const emptyDraft: Draft = {
  type: "mcp",
  name: "",
  description: "",
  url: "",
  authMode: "none",
  bearerCode: "",
  rows: [],
  proxyAuthStyle: "none",
  proxyAuthCredential: "",
  enabled: true,
};

/** 代理认证风格元数据：hint 说明所需凭证键（与后端 AUTH_STYLE_REQUIRED_KEYS 对齐） */
const PROXY_AUTH_META: Record<
  Draft["proxyAuthStyle"],
  { label: string; hint: string; requiredKeys: string[] }
> = {
  none: { label: "静态头", hint: "仅用上方鉴权头发请求", requiredKeys: [] },
  "basic-crumb": {
    label: "Basic+Crumb",
    hint: "Basic 认证 + POST 自动带 CRUMB（Jenkins 形态）；凭证需含键 username、apiToken",
    requiredKeys: ["username", "apiToken"],
  },
  "token-login": {
    label: "登录换令牌",
    hint: "用凭证登录 <URL>/api/token/ 换 JWT；凭证需含键 username、password",
    requiredKeys: ["username", "password"],
  },
};

const TYPE_META: Record<ConnectorType, { label: string; hint: string; urlPlaceholder: string }> = {
  mcp: {
    label: "MCP 服务",
    hint: "注册外部 MCP（当前支持 streamable HTTP），智能体勾选后获得其工具",
    urlPlaceholder: "https://…/mcp",
  },
  http: {
    label: "HTTP 接口",
    hint: "登记普通 HTTP/HTTPS 接口（承载配置与凭证；暂不注入智能体工具）",
    urlPlaceholder: "https://api.example.com/v1/resource",
  },
};

/** 从既有 headers 反推表单形态（Bearer 引用 / 空 / 自定义 KV） */
function draftFromConnector(c: ConnectorDTO): Draft {
  const base: Draft = {
    ...emptyDraft,
    type: c.type,
    name: c.name,
    description: c.description ?? "",
    url: c.url,
    proxyAuthStyle: c.auth?.style ?? "none",
    proxyAuthCredential: c.auth?.credential ?? "",
    enabled: c.enabled,
  };
  const entries = Object.entries(c.headers);
  if (entries.length === 0) return base;
  const first = entries[0];
  if (
    entries.length === 1 &&
    first?.[0] === "Authorization" &&
    /^Bearer \{\{credential:[A-Za-z0-9_-]+\}\}$/.test(first[1] ?? "")
  ) {
    return {
      ...base,
      authMode: "bearer",
      bearerCode: (first[1] ?? "").replace(/^Bearer \{\{credential:|\}\}$/g, ""),
    };
  }
  return {
    ...base,
    authMode: "custom",
    rows: entries.map(([key, value]) => ({ id: crypto.randomUUID(), key, value })),
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-[13px] font-semibold">{label}</span>
      {children}
    </label>
  );
}

export function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [_reloadSeq, setReloadSeq] = useState(0);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectorDTO | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<ConnectorDTO | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmShare, setConfirmShare] = useState<{
    c: ConnectorDTO;
    toScope: "global" | "private";
  } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const [credentialOptions, setCredentialOptions] = useState<Array<{ code: string; name: string }>>(
    [],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setConnectors(await fetchConnectors());
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
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

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft);
    setTestResult(null);
    setSaveError(null);
    setDialogOpen(true);
  };

  const openEdit = (c: ConnectorDTO) => {
    setEditing(c);
    setDraft(draftFromConnector(c));
    setTestResult(null);
    setSaveError(null);
    setDialogOpen(true);
  };

  const closeDialog = () => setDialogOpen(false);

  const save = async () => {
    if (!draft.name.trim() || !draft.url.trim()) return;
    setBusy(true);
    setSaveError(null);
    try {
      const input: ConnectorInput = {
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        type: draft.type,
        url: draft.url.trim(),
        headers: headersOf(draft),
        // 代理认证仅 http 型有意义；none 或未选凭证时不携带（全量替换=清除）
        ...(draft.type === "http" &&
        draft.proxyAuthStyle !== "none" &&
        draft.proxyAuthCredential.trim()
          ? {
              auth: {
                style: draft.proxyAuthStyle,
                credential: draft.proxyAuthCredential.trim(),
              },
            }
          : {}),
        enabled: draft.enabled,
        shareScope: editing?.shareScope ?? "private",
      };
      if (editing) {
        await updateConnector(editing.id, input);
      } else {
        await createConnector(input);
      }
      setDialogOpen(false);
      await reload();
    } catch (e) {
      setSaveError((e as Error).message);
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
    setTogglingId(c.id);
    try {
      await updateConnector(c.id, {
        name: c.name,
        description: c.description,
        type: c.type,
        url: c.url,
        headers: c.headers,
        auth: c.auth ?? undefined,
        enabled: !c.enabled,
        shareScope: c.shareScope,
      });
      await reload();
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setTogglingId(null);
    }
  };

  const applyShare = async () => {
    if (!confirmShare) return;
    setShareBusy(true);
    setShareError(null);
    try {
      const { c, toScope } = confirmShare;
      await updateConnector(c.id, {
        name: c.name,
        description: c.description,
        type: c.type,
        url: c.url,
        headers: c.headers,
        auth: c.auth ?? undefined,
        enabled: c.enabled,
        shareScope: toScope,
      });
      setConfirmShare(null);
      await reload();
    } catch (e) {
      setShareError((e as Error).message);
    } finally {
      setShareBusy(false);
    }
  };

  const renderCard = (c: ConnectorDTO) => {
    const manageable = c.createdByMe;
    const shareable = manageable && c.type === "mcp";
    return (
      <Card key={c.id} className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {c.type === "mcp" ? <Badge tone="info">MCP</Badge> : <Badge tone="neutral">HTTP</Badge>}
          <span className="text-sm font-semibold">{c.name}</span>
          {c.shareScope === "global" ? (
            <Badge tone="primary">全局</Badge>
          ) : (
            <Badge tone="neutral">私有</Badge>
          )}
          <span className="flex-1" />
          {manageable ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              启用
              <Switch
                checked={c.enabled}
                disabled={togglingId === c.id}
                onCheckedChange={() => void toggleEnabled(c)}
              />
            </label>
          ) : null}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground" title={c.url}>
          {c.url}
        </div>
        {c.type === "http" && c.auth && c.auth.style !== "none" ? (
          <div className="text-xs text-muted-foreground">
            代理认证：
            {PROXY_AUTH_META[c.auth.style]?.label ?? c.auth.style} · 凭证 {c.auth.credential}
          </div>
        ) : null}
        {c.description && <div className="text-xs text-muted-foreground">{c.description}</div>}
        <div className="flex items-center gap-3">
          <span className="flex-1 text-xs text-muted-foreground">
            {c.type === "mcp" ? `被 ${c.usedBy} 个智能体引用` : "接口登记（不注入智能体工具）"}
          </span>
          {shareable ? (
            c.shareScope === "global" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setConfirmShare({ c, toScope: "private" });
                  setShareError(null);
                }}
              >
                取消共享
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setConfirmShare({ c, toScope: "global" });
                  setShareError(null);
                }}
              >
                <Share2 className="h-3.5 w-3.5" />
                共享
              </Button>
            )
          ) : null}
          {manageable ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => openEdit(c)}>
                编辑
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setConfirmDelete(c);
                  setDeleteError(null);
                }}
              >
                删除
              </Button>
            </>
          ) : null}
        </div>
      </Card>
    );
  };

  const renderSection = (title: string, hint: string, list: ConnectorDTO[], empty: string) => (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {empty}
        </div>
      ) : (
        <div className="space-y-3">{list.map(renderCard)}</div>
      )}
    </section>
  );

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-7">
      <PageHeader
        className="mb-5"
        title="连接器"
        description="外部能力接入：注册外部 MCP 服务（注入智能体工具）或 HTTP 接口（配置与凭证登记），凭证不进上下文"
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建连接器
          </Button>
        }
      />
      <p className="mb-4 text-xs text-muted-foreground">
        MCP 类型连接器可
        <span className="font-medium text-foreground">共享到全局</span>
        ，其他用户都能在「全局连接器」中查看；鉴权头支持引用
        <span className="font-medium text-foreground">凭证模板</span>（{"{{credential:code}}"}
        ）——共享连接器执行时使用
        <span className="font-medium text-foreground">访问者自己的</span>凭证值。
      </p>

      {loadError ? (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => setReloadSeq((v) => v + 1)}>
            重试
          </Button>
        </div>
      ) : null}

      {loading && connectors.length === 0 ? (
        <div className="space-y-3" aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : (
        <>
          {renderSection(
            "我的连接器",
            `${mine.length} 个`,
            mine,
            "暂无连接器，点击右上角「新建连接器」创建。",
          )}
          {renderSection(
            "全局连接器",
            `${global.length} 个 · 人人可用，仅创建人可管理`,
            global,
            "暂无他人共享的全局连接器。",
          )}
        </>
      )}

      {/* 新建 / 编辑弹窗 */}
      {dialogOpen && (
        <DialogShell
          title={editing ? `编辑连接器 ${editing.name}` : "新建连接器"}
          subtitle="鉴权头支持 {{credential:code}} 凭证引用，共享时按访问者解析"
          onClose={closeDialog}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={testBusy || !draft.url.trim()}
                onClick={() => void runTest()}
              >
                <Play className="h-3 w-3" />
                {testBusy ? "测试中…" : "测试连接"}
              </Button>
              {testResult ? (
                testResult.ok ? (
                  <Badge tone="success">
                    {draft.type === "mcp"
                      ? `连接成功 · ${testResult.latencyMs}ms · ${testResult.toolCount} 个工具`
                      : `连接成功 · ${testResult.latencyMs}ms`}
                  </Badge>
                ) : (
                  <Badge tone="danger">{testResult.error}</Badge>
                )
              ) : null}
              <span className="flex-1" />
              <Button variant="secondary" size="sm" onClick={closeDialog}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={busy || !draft.name.trim() || !draft.url.trim()}
                onClick={() => void save()}
              >
                {busy ? "保存中…" : editing ? "保存修改" : "创建"}
              </Button>
            </>
          }
        >
          {saveError ? (
            <div className="rounded-lg bg-destructive-soft p-2.5 text-sm text-destructive">
              {saveError}
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">类型</span>
            <Segmented
              name="连接器类型"
              options={[
                { value: "mcp", label: TYPE_META.mcp.label },
                { value: "http", label: TYPE_META.http.label },
              ]}
              value={draft.type}
              disabled={editing !== null}
              onChange={(t) => setDraft((d) => ({ ...d, type: t }))}
            />
            <p className="text-xs text-muted-foreground">
              {TYPE_META[draft.type].hint}
              {editing ? "（已创建的连接器不可更改类型）" : ""}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="名称">
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder={draft.type === "mcp" ? "如：企业 CRM 查询" : "如：内部工单 API"}
              />
            </Field>
          </div>
          <Field label="说明（可选）">
            <Input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder={draft.type === "mcp" ? "这个连接器提供什么工具" : "这个接口提供什么能力"}
            />
          </Field>
          <Field label="URL">
            <Input
              mono
              value={draft.url}
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              placeholder={TYPE_META[draft.type].urlPlaceholder}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">鉴权方式</span>
            <Segmented
              name="鉴权方式"
              options={[
                { value: "none", label: "无" },
                { value: "bearer", label: "Bearer Token" },
                { value: "custom", label: "自定义头部" },
              ]}
              value={draft.authMode}
              onChange={(m) => setDraft((d) => ({ ...d, authMode: m }))}
            />
          </div>
          {draft.authMode === "bearer" && (
            <Field label="凭证模板">
              <Select
                value={draft.bearerCode}
                onChange={(e) => setDraft((d) => ({ ...d, bearerCode: e.target.value }))}
              >
                <option value="">选择凭证模板…</option>
                {credentialOptions.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}（{t.code}）
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {draft.authMode === "bearer" && draft.bearerCode && (
            <p className="font-mono text-xs text-muted-foreground">
              Authorization: Bearer {"{{credential:"}
              {draft.bearerCode}
              {"}}"}
            </p>
          )}
          {draft.authMode === "custom" && (
            <div className="space-y-1.5">
              {draft.rows.map((row) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    className="w-48"
                    mono
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
                  <Input
                    className="flex-1"
                    mono
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
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="删除该头部"
                    onClick={() =>
                      setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== row.id) }))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    rows: [...d.rows, { id: crypto.randomUUID(), key: "", value: "" }],
                  }))
                }
              >
                <Plus className="h-3.5 w-3.5" />
                添加头部
              </Button>
            </div>
          )}
          {draft.type === "http" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold">代理认证（应用出网通道用）</span>
              <Segmented
                name="代理认证"
                options={[
                  { value: "none", label: PROXY_AUTH_META.none.label },
                  { value: "basic-crumb", label: PROXY_AUTH_META["basic-crumb"].label },
                  { value: "token-login", label: PROXY_AUTH_META["token-login"].label },
                ]}
                value={draft.proxyAuthStyle}
                onChange={(m) => setDraft((d) => ({ ...d, proxyAuthStyle: m }))}
              />
              <p className="text-xs text-muted-foreground">
                {PROXY_AUTH_META[draft.proxyAuthStyle].hint}
              </p>
              {draft.proxyAuthStyle !== "none" && (
                <Field label="凭证模板">
                  <Select
                    value={draft.proxyAuthCredential}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, proxyAuthCredential: e.target.value }))
                    }
                  >
                    <option value="">选择凭证模板…</option>
                    {credentialOptions.map((t) => (
                      <option key={t.code} value={t.code}>
                        {t.name}（{t.code}）
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          )}
        </DialogShell>
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

      <ConfirmDialog
        open={confirmShare !== null}
        title={
          confirmShare?.toScope === "global"
            ? `共享连接器 ${confirmShare?.c.name ?? ""} 到全局`
            : `取消共享 ${confirmShare?.c.name ?? ""}`
        }
        description={
          confirmShare?.toScope === "global"
            ? "共享后所有用户都能在「全局连接器」中查看并勾选给智能体；鉴权头中的凭证引用按访问者自己的凭证值解析。"
            : "取消共享后其他用户将不能再使用该连接器（已勾选它的智能体也不再注入其工具）。"
        }
        confirmText={confirmShare?.toScope === "global" ? "共享" : "取消共享"}
        destructive={confirmShare?.toScope === "private"}
        busy={shareBusy}
        error={shareError}
        onConfirm={() => void applyShare()}
        onCancel={() => {
          setConfirmShare(null);
          setShareError(null);
        }}
      />
    </div>
  );
}
