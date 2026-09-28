import { type DingTalkModuleConfig, dingTalkRobotReady } from "../domain/module-config.js";
import type { OutboundNotification } from "../ports/notification-channel.js";
import {
  clipError,
  type DeliveryOutcome,
  type NotificationChannelAdapter,
} from "../ports/notification-channel.js";
import { getAccessToken, getUserIdByUnionid, sendSingleMessage } from "../util/dingtalk-api.js";

/** 地址解析缓存条目：resolved=换算后的 staffId；native=地址本身即可用标识 */
interface ResolvedAddress {
  value: string;
  exp: number;
}

const RESOLVE_TTL_MS = 24 * 3600_000;
/** 负缓存（getbyunionid 查无=地址本身是 staffId）：短一些，防误判长期固化 */
const RESOLVE_NEG_TTL_MS = 10 * 60_000;

/**
 * 钉钉主动推送适配器（spec §4.2/§10 M2）：复用授权页钉钉三方配置（appKey/appSecret/robotCode），
 * 机器人单聊 oToMessages 投递。
 * 地址来源两套标识：钉钉 OAuth 登录身份存的是个人级 unionId（/contact/users/me），
 * 手填验证的地址是企业 staffId——oToMessages 的 userIds 只认后者。
 * 投递前统一经 resolveUserId 换算（getbyunionid），换算失败视为已是 staffId 原样投递。
 * 与会话通道 dingtalk-channel 的差异：不依赖入站消息的 recipients 内存映射，可主动触达。
 */
export class DingTalkNotificationAdapter implements NotificationChannelAdapter {
  readonly id = "dingtalk" as const;
  private readonly resolvedCache = new Map<string, ResolvedAddress>();

  constructor(private readonly getConfig: () => DingTalkModuleConfig | undefined) {}

  available(): boolean {
    return dingTalkRobotReady(this.getConfig());
  }

  async send(address: string, n: OutboundNotification): Promise<DeliveryOutcome> {
    return this.sendText(address, `**${n.title}**\n\n${n.body}`);
  }

  async sendText(address: string, text: string): Promise<DeliveryOutcome> {
    const cfg = this.getConfig();
    if (!cfg || !dingTalkRobotReady(cfg)) return { ok: false, error: "钉钉机器人未配置" };
    try {
      const token = await getAccessToken(cfg.appKey, cfg.appSecret);
      const userId = await this.resolveUserId(address, token);
      await sendSingleMessage(token, {
        robotCode: cfg.robotCode ?? "",
        userIds: [userId],
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({
          title: text.split("\n")[0]?.slice(0, 64) || "donger 通知",
          text,
        }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: clipError(String((e as Error).message)) };
    }
  }

  /** unionId→staffId 换算（带缓存）；查询失败视为地址本身就是 staffId，原样使用 */
  private async resolveUserId(address: string, corporateToken: string): Promise<string> {
    const cached = this.resolvedCache.get(address);
    if (cached && cached.exp > Date.now()) return cached.value;
    const userid = await getUserIdByUnionid(address, corporateToken);
    const value = userid ?? address;
    this.resolvedCache.set(address, {
      value,
      exp: Date.now() + (userid ? RESOLVE_TTL_MS : RESOLVE_NEG_TTL_MS),
    });
    return value;
  }
}
