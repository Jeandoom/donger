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

/** 获取用户可访问 token（OAuth code 换 token） */
export async function getUserAccessToken(
  appKey: string,
  appSecret: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; expireIn: number }> {
  const res = await fetch(
    `https://oapi.dingtalk.com/v1.0/oauth/user_accessible_token?client_id=${encodeURIComponent(appKey)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`,
    { method: "POST" },
  );
  const data = (await res.json()) as {
    accessToken?: string;
    refreshToken?: string;
    expireIn?: number;
    errCode?: number;
    errMsg?: string;
  };
  if (!data.accessToken) {
    throw new Error(`钉钉 OAuth 失败: ${data.errMsg ?? data.errCode}`);
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? "",
    expireIn: data.expireIn ?? 7200,
  };
}

/** 获取用户信息（通过 OAuth access_token） */
export async function getUserInfoByOAuth(
  accessToken: string,
): Promise<{ userId: string; name: string; avatar?: string }> {
  const res = await fetch("https://oapi.dingtalk.com/v1.0/oauth/userinfo?field=avatar,userId", {
    headers: { "x-acs-dingtalk-access-token": accessToken },
  });
  const data = (await res.json()) as {
    userId?: string;
    name?: string;
    avatar?: string;
    errCode?: number;
    errMsg?: string;
  };
  if (!data.userId) {
    throw new Error(`钉钉用户信息获取失败: ${data.errMsg ?? data.errCode}`);
  }
  return { userId: data.userId, name: data.name ?? "", avatar: data.avatar };
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
  const resText = await res.text();
  if (!res.ok) {
    throw new Error(`钉钉 createAndDeliverCard 失败 (${res.status}): ${resText}`);
  }
  console.log("[dingtalk-card] createAndDeliver 响应:", resText.slice(0, 200));
  return outTrackId;
}

/**
 * 更新 AI 卡片内容。
 * 尝试 PUT /card/instances；同时打印详细日志便于排查。
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

  console.log(
    "[dingtalk-card] PUT /card/instances, outTrackId:",
    params.outTrackId,
    "contentLen:",
    params.content.length,
  );
  const res = await fetch(CARD_UPDATE_URL, {
    method: "PUT",
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const resText = await res.text();
  if (!res.ok) {
    throw new Error(`钉钉 streamCardUpdate 失败 (${res.status}): ${resText}`);
  }
  console.log("[dingtalk-card] 更新成功:", resText.slice(0, 100));
}
