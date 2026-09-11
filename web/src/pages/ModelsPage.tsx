import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../components/ui/page-header";
import { fetchModelSettings, type ModelSettingsDTO, saveModelSettings } from "../lib/modelSettings";

export function ModelsPage() {
  const [settings, setSettings] = useState<ModelSettingsDTO>();
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const applySettings = useCallback((data: ModelSettingsDTO): void => {
    setSettings(data);
    setUrl(data.url);
    setModelsText(data.models.join("\n"));
    setDefaultModel(data.defaultModel);
  }, []);

  useEffect(() => {
    void fetchModelSettings()
      .then(applySettings)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [applySettings]);

  const models = modelsText
    .split("\n")
    .map((model) => model.trim())
    .filter((model, index, all) => model && all.indexOf(model) === index);

  async function save(): Promise<void> {
    setError("");
    setSaved(false);
    if (!url.trim() || models.length === 0 || !defaultModel) {
      setError("请填写 URL、至少一个可用模型，并选择默认模型。");
      return;
    }
    if (!models.includes(defaultModel)) {
      setError("默认模型必须包含在可用模型列表中。");
      return;
    }
    setBusy(true);
    try {
      const data = await saveModelSettings({
        url: url.trim(),
        key: key || undefined,
        models,
        defaultModel,
      });
      setKey("");
      applySettings(data);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <PageHeader
        title="模型配置"
        description="配置 Claude Agent 使用的 Anthropic 兼容服务。配置只对当前用户生效。"
      />

      {error ? (
        <div className="rounded bg-destructive-soft p-3 text-sm text-destructive">{error}</div>
      ) : null}
      {saved ? (
        <div className="rounded bg-green-50 p-3 text-sm text-green-700">已保存。</div>
      ) : null}

      <section className="space-y-4 rounded-lg border bg-background p-5">
        <label className="block space-y-1">
          <span className="text-sm font-medium">URL</span>
          <input
            className="w-full rounded border px-3 py-2 text-sm"
            placeholder="https://api.example.com/anthropic"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Key</span>
          <input
            type="password"
            className="w-full rounded border px-3 py-2 text-sm"
            placeholder={settings?.keyConfigured ? "已配置，留空保持不变" : "输入 API Key"}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">可用模型列表</span>
          <textarea
            className="w-full rounded border px-3 py-2 font-mono text-sm"
            rows={5}
            placeholder="每行一个模型，例如：\nclaude-sonnet-4-20250514"
            value={modelsText}
            onChange={(event) => setModelsText(event.target.value)}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">默认模型</span>
          <select
            className="w-full rounded border px-3 py-2 text-sm"
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
          >
            <option value="">请选择默认模型</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>

        <div className="flex justify-end">
          <button
            type="button"
            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存 Models 配置"}
          </button>
        </div>
      </section>
    </div>
  );
}
