import type { TeambitionModuleConfig } from "../domain/module-config.js";
import { getAppAccessToken, resetTeambitionTokenCache } from "../util/teambition-api.js";
import type {
  ChannelAdapter,
  ChannelStatusSnapshot,
  ChannelTestResult,
} from "../ports/channel-adapter.js";

/**
 * Teambition 渠道适配器（2026-11-05 统一通知设计）：
 * - 回原投递：任务评论（open API，app 身份；M3 收编 sourceDeliver）
 * - 入站：TB webhook task.update（POST /api/webhooks/teambition，验签防环已内建；
 *   hook 休眠中——TB 后台登记即唤醒）
 * - 无个人级出站推送（TB open API 无 oTo 类消息面）→ outboundPush=false
 * 配置真源=授权页 module_configs（appKey/appSecret/orgId）。
 */
export class TeambitionChannelAdapter implements ChannelAdapter {
  readonly id = "teambition";
  readonly displayName = "Teambition";
  readonly description = "任务事件 webhook 触发（task.update）+ 任务评论回原（app 身份）";
  readonly capabilities = {
    outboundPush: false,
    replyToSource: true,
    inbound: "webhook" as const,
  };
  readonly configSource = "module_configs" as const;
  readonly configHint = "引用授权页 Teambition 配置（appKey/appSecret/orgId）";

  constructor(
    private readonly getConfig: () => TeambitionModuleConfig | undefined,
    private readonly enabled: () => boolean = () => true,
  ) {}

  available(): boolean {
    const cfg = this.getConfig();
    return this.enabled() && !!cfg?.appKey && !!cfg?.appSecret && !!cfg?.orgId;
  }

  async testConnection(): Promise<ChannelTestResult> {
    const cfg = this.getConfig();
    if (!cfg?.appKey || !cfg?.appSecret || !cfg?.orgId) {
      return { ok: false, error: "Teambition 配置不完整（appKey/appSecret/orgId）" };
    }
    try {
      // 本地自签 app access token（open API 口径）：签名链路通即配置有效；
      // orgId 正确性由首次评论/回调验真（open API 无轻量 org 探活端点）
      resetTeambitionTokenCache();
      const token = getAppAccessToken(cfg.appKey, cfg.appSecret);
      return {
        ok: token.length > 0,
        detail: token.length > 0 ? "app access token 自签成功" : "token 为空",
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  }

  status(): ChannelStatusSnapshot {
    const cfg = this.getConfig();
    return {
      inbound: {
        mode: "webhook",
        connected: this.enabled() && !!cfg,
        detail: this.enabled() && !!cfg
          ? "端点 /api/webhooks/teambition 就绪（TB 后台登记 hook 即唤醒）"
          : "未配置或插件停用",
      },
    };
  }
}
