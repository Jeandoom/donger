/**
 * 渠道适配器契约（2026-11-05 统一通知设计 §2.1，spec 2026-11-05-unified-notification-channel-system-design）：
 * 「渠道」一等资产的统一实现层——出站推送 / 回原投递 / 入站监听（webhook|pull|stream）
 * 的能力声明制。渠道连接分区（连接器 tab2）按 capabilities 渲染：未适配能力显示
 * 「暂未适配」，无适配的渠道不进工作流/智能体的通知渠道选择列表。
 *
 * 投递逻辑不在此重写：出站投递仍走 NotificationService 既有 adapters
 * （ports/notification-channel.ts），本契约补 **连接管理面**（能力声明/连通性测试/
 * 配置真源归属/运行状态）——两套契约的分工：notification-channel 管「怎么发」，
 * channel-adapter 管「这个渠道是什么、通不通、听不听」。
 */
import type { ReplyAnchor } from "../domain/event.js";
import type { PlatformMessageEnvelope } from "../domain/event-payloads.js";

export type ChannelInboundMode = "webhook" | "pull" | "stream";

export interface ChannelCapabilities {
  /** 订阅矩阵可选（地址簿投递） */
  outboundPush: boolean;
  /** 回原投递（锚点消费，通知轮 source 通道） */
  replyToSource: boolean;
  /** 入站监听形态；null=该渠道无入站能力 */
  inbound: ChannelInboundMode | null;
}

export interface ChannelTestResult {
  ok: boolean;
  error?: string;
  /** 测试细节（耗时/探活目标形态），卡片展示用 */
  detail?: string;
}

/** 渠道运行状态快照（渠道连接卡片展示；缺省无入站/运行态的渠道不实现） */
export interface ChannelStatusSnapshot {
  /** 入站监听状态：{mode, connected, detail?} 等，自由结构 */
  inbound?: Record<string, unknown>;
}

export interface ChannelReplyMessage {
  title?: string;
  /** 正文（markdown；各适配器自行裁剪平台长度限制） */
  body: string;
  /** 触发通知轮的 run id（审计取证） */
  runId?: string;
}

export interface ChannelDelivery {
  ok: boolean;
  error?: string;
  /** 平台侧回执句柄（评论 dynamicId / 群消息 id），落审计 */
  receipt?: Record<string, unknown>;
}

/** 配置真源归属（拍板 D6 混合） */
export type ChannelConfigSource =
  | "module_configs"
  | "address_book"
  | "connection";

export interface ChannelAdapter {
  /** 渠道键（dingtalk/teambition/email/webhook/lark/...），注册表唯一 */
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: ChannelCapabilities;
  readonly configSource: ChannelConfigSource;
  /** 配置归属的人读说明（卡片展示：「引用授权页配置」/「按用户地址簿配置」/...） */
  readonly configHint: string;

  /** 就绪门：凭证在位 + 插件门开启（platform.* 模式） */
  available(): boolean;

  /** 连通性测试（渠道连接卡片「测试」按钮；可能发起真实外部探活请求） */
  testConnection(): Promise<ChannelTestResult>;

  /** 运行/入站状态快照（无运行态的渠道不实现） */
  status?(): ChannelStatusSnapshot;

  /** 回原投递（M3 收编 sourceDeliver；锚点=自描述信封） */
  replyToSource?(anchor: ReplyAnchor, message: ChannelReplyMessage): Promise<ChannelDelivery>;

  /**
   * 入站 webhook 归一（M3 收编）：capabilities.inbound==="webhook" 时实现——
   * HTTP 面（路由/限流/验签响应）留在 web-channel，归一逻辑（payload→统一信封）
   * 委托适配器；null=非本渠道事件形态（调用方快速 200 应答）。
   */
  normalizeWebhook?(payload: unknown): PlatformMessageEnvelope | null;
}
