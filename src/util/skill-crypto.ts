import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM 加密：返回 base64(iv):base64(authTag):base64(ciphertext)。key 为 64 位 hex（32 字节）。 */
export function encryptValue(keyHex: string, plain: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptValue(keyHex: string, packed: string): string {
  const [ivB, tagB, dataB] = packed.split(":");
  if (!ivB || !tagB || !dataB) throw new Error("密文格式非法");
  const key = Buffer.from(keyHex, "hex");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(dataB, "base64")), d.final()]).toString("utf8");
}
