// 邮箱注册的密码哈希：Node 内置 scrypt，零依赖。
// 存储格式：scrypt$<salt hex>$<hash hex>（N=16384 默认参数，16B salt / 64B key）。

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1] ?? "", "hex");
  const expected = Buffer.from(parts[2] ?? "", "hex");
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;
  const actual = scryptSync(password, salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}
