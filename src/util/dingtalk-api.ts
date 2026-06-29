import type { OutgoingMessage } from "../domain/types.js";

const GETTOKEN_URL = "https://oapi.dingtalk.com/gettoken";
const SINGLE_SEND_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
const CARD_INSTANCE_URL = "https://api.dingtalk.com/v1.0/card/instances";

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

/** singleSend 请求体（纯函数）。text→SampleTextMessage；markdown→SampleMarkdownMsg。 */
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

/** 调用 singleSend 发送单聊消息。 */
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

/** 创建 AI 卡片实例（首次发送）。返回 outTrackId（用于后续更新）。 */
export async function createCardInstance(
  token: string,
  params: {
    robotCode: string;
    conversationId: string;
    cardTemplateId: string;
    content: string;
    title?: string;
  },
): Promise<string> {
  const outTrackId = `donger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(CARD_INSTANCE_URL, {
    method: "POST",
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      outTrackId,
      robotCode: params.robotCode,
      conversationId: params.conversationId,
      cardTemplateId: params.cardTemplateId,
      callbackType: "STREAM",
      cardData: {
        cardParamMap: {
          title: params.title ?? "donger",
          content: params.content,
          streaming: "true",
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`钉钉 createCardInstance 失败 (${res.status}): ${text}`);
  }
  return outTrackId;
}

/** 更新 AI 卡片内容（流式更新）。 */
export async function updateCardInstance(
  token: string,
  params: {
    outTrackId: string;
    content: string;
    title?: string;
    done?: boolean;
  },
): Promise<void> {
  const res = await fetch(CARD_INSTANCE_URL, {
    method: "PUT",
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      outTrackId: params.outTrackId,
      cardData: {
        cardParamMap: {
          title: params.title ?? "donger",
          content: params.content,
          streaming: params.done ? "false" : "true",
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`钉钉 updateCardInstance 失败 (${res.status}): ${text}`);
  }
}
