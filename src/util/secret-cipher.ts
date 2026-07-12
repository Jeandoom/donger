import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const SALT = Buffer.from("donger-agent-secret-salt-v1", "utf8");
const PREFIX = "v1:";

export class SecretCipher {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("masterKey 必须为 32 字节");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv(ALGO, this.masterKey, iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
  }

  decrypt(blob: string): string {
    if (!blob.startsWith(PREFIX)) throw new Error("密文缺少版本前缀");
    const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
    if (raw.length < 28) throw new Error("密文长度异常");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const d = createDecipheriv(ALGO, this.masterKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  }
}

/** 从 seed（SECRET_KEY 或 JWT_SECRET）派生稳定主密钥。空 seed 抛错。 */
export function createSecretCipher(seed: string): SecretCipher {
  if (!seed) throw new Error("secret seed 为空");
  const key = pbkdf2Sync(seed, SALT, 100_000, 32, "sha256");
  return new SecretCipher(key);
}
