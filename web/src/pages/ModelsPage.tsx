import { useCallback, useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import {
  createLlmProvider,
  deleteLlmProvider,
  fetchLlmPlatforms,
  fetchLlmProviders,
  type LlmPlatformInfo,
  type LlmProvider,
  type LlmProvidersResponse,
  type LlmTestResult,
  testLlmProvider,
  updateLlmProvider,
} from "../lib/llmProviders";
import { cn } from "../lib/utils";

/** 表单态：editing=null 关闭；"new" 新建；其余为编辑中的 provider id */
interface ProviderForm {
  editing: string | null;
  name: string;
  platform: string;
  baseUrl: string;
  key: string;
  modelsText: string;
  isDefault: boolean;
  /** 仅 custom 平台可选手册（其余平台由注册表锁定）；决定执行引擎 */
  sdkType: "anthropic" | "openai" | "zcode";
}

const EMPTY_FORM: ProviderForm = {
  editing: null,
  name: "",
  platform: "",
  baseUrl: "",
  key: "",
  modelsText: "",
  isDefault: false,
  sdkType: "anthropic",
};

function platformName(platforms: LlmPlatformInfo[], id: string): string {
  return platforms.find((p) => p.id === id)?.name ?? id;
}

export function ModelsPage() {
  const [platforms, setPlatforms] = useState<LlmPlatformInfo[]>([]);
  const [data, setData] = useState<LlmProvidersResponse>();
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState<LlmProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, LlmTestResult | "testing">>({});

  const reload = useCallback(async (): Promise<void> => {
    const loaded = await fetchLlmProviders();
    setData(loaded);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [p, d] = await Promise.all([fetchLlmPlatforms(), fetchLlmProviders()]);
        setPlatforms(p);
        setData(d);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
  }, []);

  const selectedPlatform = platforms.find((p) => p.id === form.platform);
  const models = form.modelsText
    .split("\n")
    .map((m) => m.trim())
    .filter((m, index, all) => m && all.indexOf(m) === index);

  function startCreate(): void {
    setError("");
    setSaved(false);
    const first = platforms[0];
    setForm({
      ...EMPTY_FORM,
      editing: "new",
      platform: first?.id ?? "",
      modelsText: (first?.models ?? []).join("\n"),
    });
  }

  function startEdit(provider: LlmProvider): void {
    setError("");
    setSaved(false);
    setForm({
      editing: provider.id,
      name: provider.name,
      platform: provider.platform,
      baseUrl: provider.baseUrl,
      key: "",
      modelsText: provider.models.join("\n"),
      isDefault: provider.isDefault,
      sdkType: provider.sdkType ?? "anthropic",
    });
  }

  function switchPlatform(platformId: string): void {
    const platform = platforms.find((p) => p.id === platformId);
    setForm((f) => ({
      ...f,
      platform: platformId,
      // 换平台重置 baseUrl/模型预填/sdkType（仅新建时可换平台）
      baseUrl: platform?.custom ? "" : (platform?.baseUrl ?? ""),
      modelsText: (platform?.models ?? []).join("\n"),
      sdkType: platform?.custom ? "anthropic" : (platform?.sdkType ?? "anthropic"),
    }));
  }

  async function save(): Promise<void> {
    if (!form.editing || !selectedPlatform) return;
    setError("");
    setSaved(false);
    if (!form.name.trim() || models.length === 0) {
      setError("请填写名称与至少一个模型。");
      return;
    }
    if (selectedPlatform.custom && !form.baseUrl.trim()) {
      setError("自定义平台必须填写服务地址（baseUrl）。");
      return;
    }
    if (form.editing === "new" && !form.key.trim()) {
      setError("新建配置必须填写 API Key。");
      return;
    }
    setBusy(true);
    try {
      const input = {
        name: form.name.trim(),
        platform: selectedPlatform.id,
        ...(selectedPlatform.custom ? { baseUrl: form.baseUrl.trim() } : {}),
        ...(selectedPlatform.custom ? { sdkType: form.sdkType } : {}),
        ...(form.key.trim() ? { key: form.key.trim() } : {}),
        models,
        isDefault: form.isDefault,
      };
      if (form.editing === "new") {
        await createLlmProvider(input);
      } else {
        await updateLlmProvider(form.editing, input);
      }
      await reload();
      setForm(EMPTY_FORM);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(provider: LlmProvider): Promise<void> {
    setError("");
    setTestResults((prev) => ({ ...prev, [provider.id]: "testing" }));
    try {
      const result = await testLlmProvider(provider.id);
      setTestResults((prev) => ({ ...prev, [provider.id]: result }));
    } catch (reason) {
      setTestResults((prev) => ({
        ...prev,
        [provider.id]: {
          ok: false,
          kind: "network",
          message: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleting) return;
    try {
      await deleteLlmProvider(deleting.id);
      setDeleting(null);
      await reload();
    } catch (reason) {
      setDeleting(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function setDefault(provider: LlmProvider): Promise<void> {
    setError("");
    try {
      await updateLlmProvider(provider.id, {
        name: provider.name,
        platform: provider.platform,
        models: provider.models,
        isDefault: true,
      });
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <PageHeader
        title="模型配置"
        description="配置对话使用的 Anthropic 兼容模型服务。可维护多条配置，选择一条作为默认；配置只对当前用户生效。"
      />

      {error ? (
        <div className="rounded bg-destructive-soft p-3 text-sm text-destructive">{error}</div>
      ) : null}
      {saved ? (
        <div className="rounded bg-green-50 p-3 text-sm text-green-700">已保存。</div>
      ) : null}

      <section className="space-y-2 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">系统默认模型</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge tone="neutral">默认</Badge>
          <span className="font-mono">{data?.systemDefaultModel || "未配置"}</span>
          {(data?.systemPresets ?? []).map((preset) => (
            <Badge key={preset.id} tone="info">
              {preset.name}（{preset.model}）
            </Badge>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          由服务端 .env 配置，所有用户共享；未设置个人默认时使用系统默认。
        </p>
      </section>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">我的模型配置</h2>
        <Button size="sm" disabled={form.editing !== null} onClick={startCreate}>
          新增配置
        </Button>
      </div>

      {form.editing !== null && selectedPlatform ? (
        <section className="space-y-4 rounded-xl border border-primary/40 bg-card p-5">
          <h3 className="text-sm font-semibold">
            {form.editing === "new" ? "新增配置" : "编辑配置"}
          </h3>
          <label className="block space-y-1" htmlFor="llm-provider-platform">
            <span className="text-sm font-medium">平台</span>
            <Select
              id="llm-provider-platform"
              value={form.platform}
              disabled={form.editing !== "new"}
              onChange={(e) => switchPlatform(e.target.value)}
            >
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {selectedPlatform.note ? (
              <span className="text-xs text-muted-foreground">{selectedPlatform.note}</span>
            ) : null}
          </label>

          <label className="block space-y-1" htmlFor="llm-provider-name">
            <span className="text-sm font-medium">配置名称</span>
            <Input
              id="llm-provider-name"
              placeholder="如：我的智谱"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>

          {selectedPlatform.custom ? (
            <label className="block space-y-1" htmlFor="llm-provider-sdk-type">
              <span className="text-sm font-medium">端点协议（决定执行引擎）</span>
              <Select
                id="llm-provider-sdk-type"
                value={form.sdkType}
                onChange={(e) =>
                  setForm({ ...form, sdkType: e.target.value as "anthropic" | "openai" | "zcode" })
                }
              >
                <option value="anthropic">Anthropic 兼容（Claude 引擎）</option>
                <option value="openai">OpenAI 协议（Codex 引擎）</option>
                <option value="zcode">ZCode 引擎（GLM 官方 harness）</option>
              </Select>
              <span className="text-xs text-muted-foreground">
                OpenAI 协议经内置 Responses↔Chat 桥接入（无交互审批门、AskUserQuestion 不可用）；ZCode 引擎经 ZCode CLI 驱动，服务端需安装 ZCode CLI（DONGER_ZCODE_CLI_PATH）
              </span>
            </label>
          ) : null}

          <label className="block space-y-1" htmlFor="llm-provider-base-url">
            <span className="text-sm font-medium">
              {form.sdkType === "openai" && selectedPlatform.custom
                ? "服务地址（OpenAI 协议 baseUrl，chat/completions 根）"
                : "服务地址（Anthropic 兼容 baseUrl）"}
            </span>
            <Input
              id="llm-provider-base-url"
              className="font-mono"
              disabled={!selectedPlatform.custom}
              placeholder={selectedPlatform.custom ? "https://your-gateway/anthropic" : ""}
              value={selectedPlatform.custom ? form.baseUrl : selectedPlatform.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
            {!selectedPlatform.custom ? (
              <span className="text-xs text-muted-foreground">由平台预设，不可修改</span>
            ) : null}
          </label>

          <label className="block space-y-1" htmlFor="llm-provider-key">
            <span className="text-sm font-medium">API Key</span>
            <Input
              id="llm-provider-key"
              type="password"
              placeholder={form.editing === "new" ? "输入平台 API Key" : "留空保持不变"}
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>

          <label className="block space-y-1" htmlFor="llm-provider-models">
            <span className="text-sm font-medium">可用模型（每行一个；默认使用第一个）</span>
            <Textarea
              id="llm-provider-models"
              mono
              rows={5}
              value={form.modelsText}
              onChange={(e) => setForm({ ...form, modelsText: e.target.value })}
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            />
            设为我的默认配置
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => setForm(EMPTY_FORM)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </section>
      ) : null}

      {(data?.providers ?? []).length === 0 && form.editing === null ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          还没有模型配置。点击「新增配置」开始。
        </p>
      ) : null}

      <div className="space-y-3">
        {(data?.providers ?? []).map((provider) => {
          const test = testResults[provider.id];
          return (
            <div
              key={provider.id}
              className={cn(
                "space-y-2 rounded-xl border border-border bg-card p-4",
                provider.isDefault && "border-primary/50",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{provider.name}</span>
                <Badge tone="neutral">{platformName(platforms, provider.platform)}</Badge>
                {provider.isDefault ? <Badge tone="info">我的默认</Badge> : null}
                {provider.sdkType === "openai" ? <Badge tone="warning">OpenAI 协议</Badge> : null}
              </div>
              <div className="font-mono text-xs text-muted-foreground">{provider.baseUrl}</div>
              <div className="flex flex-wrap gap-1">
                {provider.models.map((model) => (
                  <span
                    key={model}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                  >
                    {model}
                  </span>
                ))}
              </div>
              {test ? (
                <div
                  className={cn(
                    "rounded p-2 text-xs",
                    test === "testing"
                      ? "bg-muted text-muted-foreground"
                      : test.ok
                        ? "bg-green-50 text-green-700"
                        : "bg-destructive-soft text-destructive",
                  )}
                >
                  {test === "testing"
                    ? "测试中…"
                    : test.ok
                      ? `连接成功（${test.model}）。注意：连通不代表流式与工具调用全兼容，建议实跑验证。`
                      : test.message}
                </div>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                {!provider.isDefault ? (
                  <Button size="sm" variant="secondary" onClick={() => void setDefault(provider)}>
                    设为默认
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={test === "testing"}
                  onClick={() => void runTest(provider)}
                >
                  测试连接
                </Button>
                <Button size="sm" variant="secondary" onClick={() => startEdit(provider)}>
                  编辑
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleting(provider)}>
                  删除
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title="删除模型配置"
        description={deleting ? `确定删除「${deleting.name}」？保存后无法恢复。` : undefined}
        confirmText="删除"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
