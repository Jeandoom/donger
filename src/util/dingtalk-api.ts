import type { OutgoingMessage } from "../domain/types.js";

const GETTOKEN_URL = "https://oapi.dingtalk.com/gettoken";
const SINGLE_SEND_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
const CARD_CREATE_DELIVER_URL = "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver";
const CARD_UPDATE_URL = "https://api.dingtalk.com/v1.0/card/instances";

interface TokenCache {
  value: string;
  exp: number;
}
let tokenCache: TokenCache | null = null;

/** 获取并缓存 access_token（提前 60s 刷新；默认 expires_in=7200s）。 */
export async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 60_000) return tokenCache.value;
  const url = `${GETTOKEN_URL}?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const res = await fetch(url);
  const j = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
  };
  if (!j.access_token) {
    throw new Error(`钉钉 gettoken 失败: ${j.errmsg ?? j.errcode ?? "未知"}`);
  }
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 7200) * 1000 };
  return tokenCache.value;
}

/** 重置 token 缓存（测试用）。 */
export function resetDingTalkTokenCache(): void {
  tokenCache = null;
}

/** singleSend 请求体（纯函数）。 */
export function buildSingleSendBody(
  robotCode: string,
  userId: string,
  msg: OutgoingMessage,
): { robotCode: string; userIds: string[]; msgKey: string; msgParam: string } {
  if (msg.markdown) {
    return {
      robotCode,
      userIds: [userId],
      msgKey: "sampleMarkdownMsg",
      msgParam: JSON.stringify({
        title: msg.text.split("\n")[0]?.trim().slice(0, 50) || "donger",
        text: msg.text,
      }),
    };
  }
  return {
    robotCode,
    userIds: [userId],
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: msg.text }),
  };
}

/** 调用 singleSend 发送单聊消息（降级用）。 */
export async function sendSingleMessage(
  token: string,
  body: { robotCode: string; userIds: string[]; msgKey: string; msgParam: string },
): Promise<void> {
  const res = await fetch(SINGLE_SEND_URL, {
    method: "POST",
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`钉钉 singleSend 失败 (${res.status}): ${text}`);
  }
}

/**
 * 创建并投递 AI 卡片（createAndDeliver）。
 * 参考：钉钉官方 @alicloud/dingtalk/card_1_0 createAndDeliverWithOptions
 * 返回 outTrackId（用于后续流式更新）。
 */
export async function createAndDeliverCard(
  token: string,
  params: {
    userId: string;
    robotCode: string;
    cardTemplateId: string;
    content: string;
    title?: string;
  },
): Promise<string> {
  const outTrackId = `donger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const summary = params.title ?? params.content.slice(0, 30);

  // cardParamMap 所有值必须是 string
  const cardParamMap: Record<string, string> = {
    content: params.content,
    title: summary,
    lastMessage: summary,
    config: JSON.stringify({ autoLayout: true }),
  };

  const body = {
    outTrackId,
    userId: params.userId,
    userIdType: 1, // staffId
    cardTemplateId: params.cardTemplateId,
    callbackType: "STREAM",
    cardData: { cardParamMap },
    openSpaceId: `dtv1.card//im_robot.${params.userId}`,
    imRobotOpenDeliverModel: {
      spaceType: "IM_ROBOT",
      robotCode: params.robotCode,
    },
    imRobotOpenSpaceModel: {
      supportForward: true,
      lastMessageI18n: { ZH_CN: summary },
    },
  };

  const res = await fetch(CARD_CREATE_DELIVER_URL, {
    method: "POST",
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`钉钉 createAndDeliverCard 失败 (${res.status}): ${text}`);
  }
  return outTrackId;
}

/**
 * 更新 AI 卡片内容（PUT /card/instances）。
 * agent 每输出一段文本 → 调一次此方法 → 卡片内容实时刷新。
 */
export async function streamCardUpdate(
  token: string,
  params: {
    outTrackId: string;
    content: string;
    isFinal?: boolean;
  },
): Promise<void> {
  const cardParamMap: Record<string, string> = {
    content: params.content,
    config: JSON.stringify({ autoLayout: true }),
  };

  const body = {
    outTrackId: params.outTrackId,
    cardData: { cardParamMap },
  };

  const res = await fetch(CARD_UPDATE_URL, {
    method: "PUT",
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`钉钉 streamCardUpdate 失败 (${res.status}): ${text}`);
  }
}
