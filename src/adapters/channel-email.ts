import type { EmailModuleConfig } from "../domain/module-config.js";
import nodemailer from "nodemailer";
import type {
  ChannelAdapter,
  ChannelTestResult,
} from "../ports/channel-adapter.js";

/**
 * 邮件渠道适配器（2026-11-05 统一通知设计）：
 * - 出站推送：SMTP（投递地址=用户注册邮箱，登录通道可信免地址簿绑定）
 * - 无回原（无邮件入站源）；入站 IMAP 拉取为 M4 预留（本期 null——契约声明制，
 *   卡片显示「暂未适配」）
 * 配置真源=授权页 email 模块 SMTP 段（password 加密落库）。
 */
export class EmailChannelAdapter implements ChannelAdapter {
  readonly id = "email";
  readonly displayName = "邮件";
  readonly description = "SMTP 出站通知（收件地址=注册邮箱；管理员在授权页配置 SMTP）";
  readonly capabilities = {
    outboundPush: true,
    replyToSource: false,
    inbound: null,
  };
  readonly configSource = "module_configs" as const;
  readonly configHint = "引用授权页邮箱配置（SMTP host/port/from/password）";

  constructor(private readonly getConfig: () => EmailModuleConfig | undefined) {}

  available(): boolean {
    const smtp = this.getConfig()?.smtp;
    return !!smtp?.host && !!smtp.from;
  }

  async testConnection(): Promise<ChannelTestResult> {
    const smtp = this.getConfig()?.smtp;
    if (!smtp?.host || !smtp.from) {
      return { ok: false, error: "SMTP 未配置（host/from 缺失，授权页邮箱模块）" };
    }
    try {
      const started = Date.now();
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure ?? false,
        auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? "" } : undefined,
      });
      await transport.verify();
      transport.close();
      return { ok: true, detail: `SMTP 握手成功（${Date.now() - started}ms）` };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  }
}
