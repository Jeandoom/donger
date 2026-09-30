import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const SALT = Buffer.from("donger-agent-secret-salt-v1", "utf8");
const PREFIX = "v1:";

export class SecretCipher {
  private masterKey!: Buffer;
  /** 历史密钥回退链：当前密钥解不开时依次尝试（轮换竞态窗口/残留密文的兜底） */
  private fallbacks: SecretCipher[] = [];

  constructor(masterKey: Buffer) {
    this.setMasterKey(masterKey);
  }

  /** 轮换：原子替换主密钥（即刻用于新加密；存量旧密文靠 fallbacks 兜底） */
  setMasterKey(masterKey: Buffer): void {
    if (masterKey.length !== 32) throw new Error("masterKey 必须为 32 字节");
    this.masterKey = masterKey;
  }

  setFallbacks(fallbacks: SecretCipher[]): void {
    this.fallbacks = fallbacks;
  }

  /** 派生密钥暴露（live cipher 换钥用：setMasterKey(other.accessKey())） */
  accessKey(): Buffer {
    return this.masterKey;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv(ALGO, this.masterKey, iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
  }

  decrypt(blob: string): string {
    try {
      return this.decryptStrict(blob);
    } catch (e) {
      for (const fb of this.fallbacks) {
        try {
          return this.decryptWith(fb.masterKey, blob);
        } catch {
          // 下一把历史密钥
        }
      }
      // GCM 认证失败 = 加密时的主密钥与当前不一致（典型：主密钥轮换/漂移），原始 CryptoError 对用户无意义
      throw new Error(
        `密钥解密失败（${(e as Error).message}）：该密文无法用当前主密钥解开，可能因平台主密钥已轮换。请管理员在「授权页·密钥管理」导入历史密钥并修复，或重新录入该密钥`,
      );
    }
  }

  /** 仅用当前主密钥解，不走回退链——迁移/轮换引擎判定密文归属必须用它，否则回退链会把旧密文误判为健康 */
  decryptStrict(blob: string): string {
    return this.decryptWith(this.masterKey, blob);
  }

  private decryptWith(key: Buffer, blob: string): string {
    if (!blob.startsWith(PREFIX)) throw new Error("密文缺少版本前缀");
    const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
    if (raw.length < 28) throw new Error("密文长度异常");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const d = createDecipheriv(ALGO, key, iv);
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
