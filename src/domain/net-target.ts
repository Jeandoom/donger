import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * 出站目标内网判定（触发器 http source 等会把响应体回读给调用者的探活面）。
 * 命中环回/私网/链路本地/保留网段返回 true——这些目标默认拦截，防「以服务端身份
 * 探测/读取内网」的 SSRF。
 */
export function isPrivateNetHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  // IPv6 字面量在 URL hostname 里带方括号
  const ipText = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  const scope = isIP(ipText);
  if (scope === 4) {
    return isPrivateIpv4(ipText);
  }
  if (scope === 6) {
    const v6 = ipText.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true; // 未指定/环回
    if (/^fe[89ab]/.test(v6)) return true; // 链路本地 fe80::/10
    if (/^f[cd]/.test(v6)) return true; // ULA fc00::/7
    // IPv4 映射地址：点分形（::ffff:10.0.0.1）与 WHATWG URL 规范化后的十六进制形
    //（::ffff:a00:1）都必须还原成 IPv4 复判——fetch 会对它们实际拨号 IPv4
    const mapped = v6.startsWith("::ffff:") ? v6.slice(7) : undefined;
    if (mapped !== undefined) {
      if (mapped.includes(".")) return isPrivateIpv4(mapped);
      const groups = mapped.split(":");
      if (groups.length !== 2) return true; // 形态不明的映射地址保守拒绝
      const hi = Number.parseInt(groups[0] ?? "", 16);
      const lo = Number.parseInt(groups[1] ?? "", 16);
      if (Number.isNaN(hi) || Number.isNaN(lo)) return true;
      return isPrivateIpv4(
        `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`,
      );
    }
    return false;
  }
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // 畸形地址保守拒绝
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true; // 本网络/私网/环回
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT（含阿里云元数据 100.100.100.200）
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网
  if (a >= 224) return true; // 组播 + 保留 E 类
  return false;
}

/**
 * 触发器 http source 的出站 URL 校验（表层）：仅 http/https，且默认拒绝内网目标。
 * allowPrivate=true（TRIGGER_ALLOW_PRIVATE_NET，本地内网联动场景显式开启）时放行私网。
 * 返回 null 表示拦截，否则返回规范化 URL 字符串。
 */
export function validateTriggerHttpUrl(rawUrl: string, allowPrivate: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!allowPrivate && isPrivateNetHost(parsed.hostname)) return null;
  return parsed.toString();
}

/**
 * 触发器 http source 的出站 URL 校验（解析级）：表层判定之外，对域名做 DNS 解析并
 * 逐地址复判——防公网通配域名（nip.io 类，如 10.0.0.1.nip.io）把私网地址挂在公网域名下
 * 绕过表层判定。解析失败一律拒绝（此时 fetch 也必然失败）。
 */
export async function validateTriggerHttpUrlDeep(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<string | null> {
  const surface = validateTriggerHttpUrl(rawUrl, allowPrivate);
  if (!surface || allowPrivate) return surface;
  let hostname: string;
  try {
    hostname = new URL(surface).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  if (isIP(hostname)) return surface; // 字面 IP 已被表层判定覆盖
  try {
    const addrs = await lookup(hostname, { all: true });
    if (addrs.length === 0) return null;
    for (const a of addrs) {
      if (isPrivateNetHost(a.address)) return null;
    }
  } catch {
    return null; // 解析失败 = 目标不可达，直接拒绝
  }
  return surface;
}
