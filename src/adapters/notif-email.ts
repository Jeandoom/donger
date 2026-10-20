// 邮件通知通道适配器（2026-10-20 反馈闭环 M3）：SMTP 出站投递。
// 配置复用授权页 email 模块（smtp 段，password 机密加密落库）；缺配置 available()=false
// → 内核记 skipped 不报错（与钉钉 adapter 同 fail-open 语义）。
// 投递地址=用户注册邮箱（登录通道本身可信，无需地址簿二次绑定）。

import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import type { EmailModuleConfig } from "../domain/module-config.js";
import type { OutboundNotification } from "../ports/notification-channel.js";
import {
  clipError,
  type DeliveryOutcome,
  type NotificationChannelAdapter,
} from "../ports/notification-channel.js";

export class EmailNotificationAdapter implements NotificationChannelAdapter {
  readonly id = "email" as const;
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor(private readonly getConfig: () => EmailModuleConfig | undefined) {
    const smtp = this.getConfig()?.smtp;
    if (!smtp?.host || !smtp.from) {
      this.transport = null;
      this.from = "";
      return;
    }
    this.from = smtp.from;
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure ?? false,
      ...(smtp.username ? { auth: { user: smtp.username, pass: smtp.password ?? "" } } : {}),
    });
  }

  available(): boolean {
    return this.transport !== null;
  }

  async send(address: string, n: OutboundNotification): Promise<DeliveryOutcome> {
    return this.sendText(address, `${n.title}\n\n${n.body}`);
  }

  async sendText(address: string, text: string): Promise<DeliveryOutcome> {
    if (!this.transport) return { ok: false, error: "SMTP 未配置" };
    try {
      await this.transport.sendMail({
        from: this.from,
        to: address,
        subject: text.split("\n")[0]?.slice(0, 120) || "donger 通知",
        // 纯文本口径：通知 body 已被内核脱敏截断，不做 HTML 渲染（避免注入面）
        text,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: clipError(String((e as Error).message)) };
    }
  }
}
