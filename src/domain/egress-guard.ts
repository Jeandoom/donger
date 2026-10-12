// 渗出闸（M2-8，INV-8，spec 2026-10-10-agent-security-kernel-design §4.5）：
// 出网能力显式授予——缺省白名单仅「平台必需域」（LLM API、localhost），白名单外的
// 显式出网（Bash curl/wget、WebFetch）一律进审批。理论依据：读能力不可归零，渗出=
// 读×外传，治理外传通道即把渗出收敛到可审计集。
// 判定输入是命令/入参文本中的显式 URL——npm/pip 一类包管理器的 registry 在自身配置里
// 不落命令文本，天然不受影响（可用性代价可控，边界=显式 URL 才触发）。

/** 从命令/文本提取显式 http(s) URL */
export function extractUrls(text: string): Array<{ url: string; host: string }> {
  const out: Array<{ url: string; host: string }> = [];
  const re = /https?:\/\/[^\s"'`<>|&)]+/g;
  for (const raw of text.match(re) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host) out.push({ url, host });
  }
  return out;
}

/** 命令/入参是否为显式出网形态：curl/wget 携带 URL，或（WebFetch 场景）直接给定 URL 文本 */
export function hasExplicitEgress(text: string): boolean {
  if (!/\b(curl|wget)(\.exe)?\b/i.test(text)) return false;
  return extractUrls(text).length > 0;
}

/** 域名白名单匹配：精确或后缀（allow "example.com" 命中 api.example.com / example.com） */
export function isHostAllowed(host: string, allowDomains: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowDomains) {
    const d = raw.trim().toLowerCase().replace(/^\*\./, "");
    if (!d) continue;
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}

/** 平台内置缺省白名单：localhost 系（LLM API 域由调用方并入——按部署实例解析） */
export const EGRESS_BUILTIN_ALLOW = ["localhost", "127.0.0.1", "[::1]", "*.local"];

export interface EgressVerdict {
  /** true=白名单外存在出网目标（须审批） */
  blocked: boolean;
  /** 白名单外的域名清单（审批卡展示） */
  deniedHosts: string[];
}

/**
 * 判定 Bash 命令 / WebFetch URL 文本的出网目标：
 * 命令含 curl/wget 且提取到 URL → 逐域过白名单；任一白名单外 → blocked。
 */
export function matchEgress(text: string, allowDomains: string[]): EgressVerdict {
  if (!hasExplicitEgress(text)) return { blocked: false, deniedHosts: [] };
  const deniedHosts: string[] = [];
  for (const { host } of extractUrls(text)) {
    if (!isHostAllowed(host, allowDomains) && !deniedHosts.includes(host)) deniedHosts.push(host);
  }
  return { blocked: deniedHosts.length > 0, deniedHosts };
}
