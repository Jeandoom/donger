import type { ReplyAnchor } from "../domain/event.js";
import type {
  ChannelAdapter,
  ChannelReplyMessage,
  ChannelDelivery,
} from "../ports/channel-adapter.js";

/**
 * 渠道连接注册表（2026-11-05 统一通知设计 §2.2）：渠道适配器唯一登记口。
 * 装配点 index.ts 注册全部内置适配器；web-channel 消费列表/测试路由；
 * M3 起入站路由与回原投递亦按注册表路由。
 */
export class ChannelConnectionRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`渠道适配器重复注册: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * 回原投递（2026-11-05 统一通知设计 §2.6，收编 index sourceDeliver 硬编码 if/else）：
   * 按 anchor.platform 路由 + 能力/就绪校验统一报错。失败向上抛（通知轮按拍板
   * 置 run failed，与收件人解析失败同级）。
   */
  async replyToSource(anchor: ReplyAnchor, message: ChannelReplyMessage): Promise<ChannelDelivery> {
    const adapter = this.adapters.get(anchor.platform);
    if (!adapter) {
      throw new Error(`回源平台未注册: ${anchor.platform}`);
    }
    if (!adapter.capabilities.replyToSource || !adapter.replyToSource) {
      throw new Error(`渠道 ${adapter.displayName} 不支持回原投递`);
    }
    if (!adapter.available()) {
      throw new Error(`渠道 ${adapter.displayName} 未启用（配置缺失或插件停用）`);
    }
    return adapter.replyToSource(anchor, message);
  }
}
