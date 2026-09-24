import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createMcpToken,
  fetchMcpConfig,
  type McpTokenCreated,
  type McpTokenRecord,
  revokeMcpToken,
} from "../../lib/mcp";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Segmented } from "../ui/segmented";
import { Select } from "../ui/select";

/**
 * MCP 接入分区（授权模块「个人接入」组，spec 2026-09-24-mcp-auth-files-design）：
 * 签发/管理个人 MCP 接入令牌（明文仅创建时展示一次），生成 zcode / Codex /
 * Claude Code 等外部 agent 的配置 JSON/TOML。令牌权限 = 属主用户在 web 端的权限。
 */

const TOOL_SUMMARY = [
  ["list_agents / get_agent", "查看可用智能体（本人 + 被分享）"],
  [
    "list_conversations / create_conversation / send_message / get_conversation_messages",
    "会话与消息（send_message 会以你的身份触发智能体执行）",
  ],
  ["list_skills", "已启用的技能包与技能"],
  ["list_knowledge_bases / search_knowledge_base / read_knowledge_base", "知识库检索与阅读"],
] as const;

type ClientKind = "claude-code" | "zcode" | "codex";

function buildConfig(kind: ClientKind, endpoint: string, token: string): string {
  if (kind === "codex") {
    return `[mcp_servers.donger]\nurl = "${endpoint}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`;
  }
  return JSON.stringify(
    {
      mcpServers: {
        donger: {
          type: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

const CLIENT_LABEL: Record<ClientKind, string> = {
  "claude-code": "Claude Code（.mcp.json）",
  zcode: "ZCode（settings.json）",
  codex: "Codex（config.toml）",
};

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? "已复制" : label}
    </Button>
  );
}

function tokenStatus(t: McpTokenRecord): {
  label: string;
  tone: "success" | "neutral" | "warning";
} {
  if (t.revokedAt) return { label: "已吊销", tone: "neutral" };
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now())
    return { label: "已过期", tone: "neutral" };
  return { label: "有效", tone: "success" };
}

export function McpSection() {
  const [config, setConfig] = useState<{
    tokens: McpTokenRecord[];
    endpoint: string | null;
  } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState("90");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<McpTokenCreated | null>(null);
  const [clientKind, setClientKind] = useState<ClientKind>("claude-code");
  const [confirmRevoke, setConfirmRevoke] = useState<McpTokenRecord | null>(null);

  const load = useCallback(() => {
    setLoadError("");
    fetchMcpConfig()
      .then(setConfig)
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const configText = useMemo(
    () => (created ? buildConfig(clientKind, created.endpoint, created.token) : ""),
    [clientKind, created],
  );

  const doCreate = () => {
    setCreating(true);
    setCreateError("");
    setCreated(null);
    createMcpToken(name.trim() || "MCP 令牌", expiryDays === "never" ? null : Number(expiryDays))
      .then((issued) => {
        setCreated(issued);
        setName("");
        load();
      })
      .catch((reason: unknown) =>
        setCreateError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setCreating(false));
  };

  const doRevoke = () => {
    if (!confirmRevoke) return;
    revokeMcpToken(confirmRevoke.id)
      .then(() => {
        setConfirmRevoke(null);
        load();
      })
      .catch(() => setConfirmRevoke(null));
  };

  const tokens = config?.tokens ?? [];
  const endpoint = config?.endpoint ?? null;

  return (
    <div className="space-y-5">
      <Card className="space-y-3 p-5">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">MCP 接入</h2>
            <Badge tone={endpoint ? "success" : "neutral"}>{endpoint ? "已开放" : "未启用"}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            用 MCP 接入令牌把本平台的智能体 / 会话 / 技能 / 知识库接入 zcode、Codex、Claude Code
            等外部 agent。令牌权限与你本人登录 web
            时完全一致；令牌明文只在创建时展示一次，请立即保存。
          </p>
        </div>
        {loadError ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive-soft p-2.5 text-sm text-destructive">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </div>
        ) : null}
        {endpoint ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>MCP 端点（Streamable HTTP）：</span>
            <code className="rounded bg-muted px-1.5 py-0.5">{endpoint}</code>
            <CopyButton text={endpoint} />
          </div>
        ) : null}
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="mb-1.5 text-[13px] font-semibold">暴露的工具</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {TOOL_SUMMARY.map(([names, desc]) => (
              <li key={names}>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{names}</code>
                <span className="ml-1.5">{desc}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">创建接入令牌</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-[13px] font-semibold">名称</span>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：我的 zcode"
              maxLength={50}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-[13px] font-semibold">有效期</span>
            <Select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}>
              <option value="7">7 天</option>
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="365">365 天</option>
              <option value="never">无限期</option>
            </Select>
          </label>
          <div className="flex items-end">
            <Button onClick={doCreate} disabled={creating || !endpoint}>
              <Plus className="h-4 w-4" />
              {creating ? "创建中…" : "创建令牌"}
            </Button>
          </div>
        </div>
        {createError ? (
          <div className="rounded-lg bg-destructive-soft p-2.5 text-sm text-destructive">
            {createError}
          </div>
        ) : null}

        {created ? (
          <div className="space-y-3 rounded-lg border border-warning/40 bg-warning-soft p-3">
            <p className="text-[13px] font-semibold">
              令牌已创建——立即复制保存，刷新后不再显示明文
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1.5 font-mono text-xs">
                {created.token}
              </code>
              <CopyButton text={created.token} label="复制令牌" />
            </div>
            <div className="space-y-2">
              <Segmented
                value={clientKind}
                onChange={(v) => setClientKind(v)}
                options={[
                  { value: "claude-code", label: "Claude Code" },
                  { value: "zcode", label: "ZCode" },
                  { value: "codex", label: "Codex" },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                配置写入 {CLIENT_LABEL[clientKind]} 后重启对应 agent 即可使用（Codex 需支持
                Streamable HTTP 的版本）。
              </p>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-card p-2.5 font-mono text-[11px] leading-relaxed">
                  {configText}
                </pre>
                <CopyButton text={configText} label="复制配置" />
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">我的接入令牌</h2>
          <Badge tone="neutral">{tokens.length}</Badge>
        </div>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有接入令牌</p>
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => {
              const status = tokenStatus(t);
              return (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{t.name}</span>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span className="font-mono">{t.tokenHint}</span>
                      <span>创建于 {new Date(t.createdAt).toLocaleString()}</span>
                      <span>
                        {t.expiresAt
                          ? `有效期至 ${new Date(t.expiresAt).toLocaleString()}`
                          : "无限期"}
                      </span>
                      {t.lastUsedAt ? (
                        <span>最近使用 {new Date(t.lastUsedAt).toLocaleString()}</span>
                      ) : (
                        <span>从未使用</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!t.revokedAt ? (
                      <Button variant="outline" size="sm" onClick={() => setConfirmRevoke(t)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        吊销
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!confirmRevoke}
        title="吊销接入令牌"
        description={
          confirmRevoke
            ? `确定吊销「${confirmRevoke.name}」（${confirmRevoke.tokenHint}）？使用它的外部 agent 将立即失去访问。`
            : ""
        }
        destructive
        busy={false}
        error=""
        onConfirm={doRevoke}
        onCancel={() => setConfirmRevoke(null)}
      />
    </div>
  );
}
