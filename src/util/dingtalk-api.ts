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
    const detail = JSON.stringify({ httpStatus: res.status, errcode: j.errcode, errmsg: j.errmsg });
    console.error("[dingtalk-api] getAccessToken 失败:", detail);
    throw new Error(`钉钉 gettoken 失败: ${detail}`);
  }
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 7200) * 1000 };
  return tokenCache.value;
}

/** 重置 token 缓存（测试用）。 */
export function resetDingTalkTokenCache(): void {
  tokenCache = null;
}

/** 用临时 code 换取钉钉用户信息（企业内部应用使用 sns/getuserinfo_bycode） */
export async function getUserInfoByCode(
  appKey: string,
  appSecret: string,
  code: string,
): Promise<{ userId: string; name: string; avatar?: string }> {
  const corpToken = await getAccessToken(appKey, appSecret);
  const urlStr = `https://oapi.dingtalk.com/sns/getuserinfo_bycode?access_token=${encodeURIComponent(corpToken)}`;
  console.log(
    "[dingtalk-api] getUserInfoByCode 请求 URL:",
    urlStr.replace(/access_token=[^&]+/, "access_token=***"),
  );
  const res = await fetch(urlStr, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tmp_auth_code: code }),
  });
  const bodyText = await res.text();
  console.log("[dingtalk-api] getUserInfoByCode 响应体:", bodyText);
  let data: {
    errcode?: number;
    errmsg?: string;
    user_info?: { userid?: string; name?: string; avatar?: string; openid?: string };
  };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    console.error("[dingtalk-api] getUserInfoByCode 响应非 JSON:", bodyText.slice(0, 300));
    throw new Error(`钉钉用户信息获取失败: HTTP ${res.status}, 响应: ${bodyText.slice(0, 200)}`);
  }
  if (data.errcode || !data.user_info?.userid) {
    const detail = JSON.stringify({
      httpStatus: res.status,
      httpUrl: urlStr.replace(/access_token=[^&]+/, "access_token=***"),
      errcode: data.errcode,
      errmsg: data.errmsg,
      raw: data,
      code: code ? `${code.slice(0, 8)}...` : undefined,
    });
    console.error("[dingtalk-api] getUserInfoByCode 失败, 详情:", detail);
    throw new Error(`钉钉用户信息获取失败: ${detail}`);
  }
  return {
    userId: data.user_info.userid,
    name: data.user_info.name ?? "",
    avatar: data.user_info.avatar,
  };
}

// ---- OAuth 2.0 回调接口（企业内部应用扫码登录用） ----

/**
 * 用 OAuth 授权码换取用户 access_token（企业内部应用）。
 * 参考：https://open.dingtalk.com/document/orgapp/obtain-user-token
 */
export async function getUserAccessToken(
  appKey: string,
  appSecret: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; expireIn: number }> {
  const urlStr = "https://api.dingtalk.com/v1.0/oauth2/userAccessToken";
  const body = {
    clientId: appKey,
    clientSecret: appSecret,
    code,
    grantType: "authorization_code",
  };
  console.log(
    "[dingtalk-api] getUserAccessToken POST 到:",
    urlStr,
    "body:",
    JSON.stringify({ ...body, clientSecret: "***" }),
  );
  const res = await fetch(urlStr, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const bodyText = await res.text();
  console.log("[dingtalk-api] getUserAccessToken 响应体:", bodyText);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    console.error("[dingtalk-api] getUserAccessToken 响应非 JSON:", bodyText.slice(0, 300));
    throw new Error(
      `钉钉 OAuth token 获取失败: HTTP ${res.status}, 响应: ${bodyText.slice(0, 200)}`,
    );
  }
  if (!data.accessToken) {
    const detail = JSON.stringify({
      httpStatus: res.status,
      errCode: data.errCode ?? data.errcode,
      errMsg: data.errMsg ?? data.errmsg,
      raw: data,
    });
    console.error("[dingtalk-api] getUserAccessToken 失败:", detail);
    throw new Error(`钉钉 OAuth token 获取失败: ${detail}`);
  }
  return {
    accessToken: data.accessToken as string,
    refreshToken: (data.refreshToken as string) ?? "",
    expireIn: (data.expireIn as number) ?? 7200,
  };
}

/**
 * 通过 OAuth access_token 获取用户信息。
 * 参考：https://open.dingtalk.com/document/orgapp/obtain-userinfo
 */
export async function getUserInfoByOAuth(
  accessToken: string,
): Promise<{ userId: string; name: string; avatar?: string }> {
  // 新版钉钉 API：GET /v1.0/contact/users/{unionId}，unionId 传 me 表示当前授权用户
  const urlStr = "https://api.dingtalk.com/v1.0/contact/users/me";
  console.log("[dingtalk-api] getUserInfoByOAuth GET", urlStr);
  const res = await fetch(urlStr, {
    headers: { "x-acs-dingtalk-access-token": accessToken },
  });
  const bodyText = await res.text();
  console.log("[dingtalk-api] getUserInfoByOAuth 响应体:", bodyText);
  let data: {
    userId?: string;
    nick?: string;
    unionId?: string;
    openId?: string;
    avatarUrl?: string;
    errCode?: number;
    errMsg?: string;
  };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    console.error("[dingtalk-api] getUserInfoByOAuth 响应非 JSON:", bodyText.slice(0, 300));
    throw new Error(`钉钉用户信息获取失败: HTTP ${res.status}, 响应: ${bodyText.slice(0, 200)}`);
  }
  // 新版接口返回 nick / unionId / avatarUrl
  if (data.errCode || data.errMsg) {
    const detail = JSON.stringify({
      httpStatus: res.status,
      errCode: data.errCode,
      errMsg: data.errMsg,
      raw: data,
    });
    console.error("[dingtalk-api] getUserInfoByOAuth 失败:", detail);
    throw new Error(`钉钉用户信息获取失败: ${detail}`);
  }
  const userId = data.userId ?? data.unionId ?? data.openId;
  if (!userId) {
    const detail = JSON.stringify({ httpStatus: res.status, raw: data });
    console.error("[dingtalk-api] getUserInfoByOAuth 无 userId:", detail);
    throw new Error(`钉钉用户信息获取失败: 响应中无 userId, ${detail}`);
  }
  return {
    userId,
    name: data.nick ?? "",
    avatar: data.avatarUrl,
  };
}

/**
 * 企业 unionId → 通讯录 userid（staffId）换算。
 * OAuth 登录身份存的是个人级 unionId，而 oToMessages batchSend 的 userIds 要企业
 * 通讯录 userid——两套标识体系，投递前须经此换算。corporateToken=企业应用 access_token。
 */
export async function getUserIdByUnionid(
  unionId: string,
  corporateToken: string,
): Promise<string | undefined> {
  const url = `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(corporateToken)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 老 oapi 接口参数全小写：unionid（非新版 REST 的 unionId 驼峰）
      body: JSON.stringify({ unionid: unionId }),
    });
    const data = (await res.json()) as {
      errcode?: number;
      errmsg?: string;
      result?: { userid?: string };
    };
    if (data.errcode === 0 && data.result?.userid) return data.result.userid;
    console.error(
      "[dingtalk-api] getbyunionid 失败:",
      JSON.stringify({ errcode: data.errcode, errmsg: data.errmsg }),
    );
    return undefined;
  } catch (e) {
    console.error("[dingtalk-api] getbyunionid 请求异常:", String((e as Error).message));
    return undefined;
  }
}

/** 钉钉开放平台错误体收敛：只留 code/message（不回显 requestid 等响应原文） */
export function parseDingTalkError(text: string): string {
  try {
    const data = JSON.parse(text) as {
      code?: string;
      message?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (data.code || data.message) return `${data.code ?? ""} ${data.message ?? ""}`.trim();
    if (data.errcode !== undefined || data.errmsg)
      return `${data.errcode ?? ""} ${data.errmsg ?? ""}`.trim();
  } catch {
    // 非 JSON 响应体
  }
  return text.slice(0, 200);
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
    throw new Error(`钉钉 singleSend 失败 (${res.status}): ${parseDingTalkError(text)}`);
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
