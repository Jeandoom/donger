import type { ChannelAdapter } from "../ports/channel-adapter.js";

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
}
