import { describe, it, expect } from "vitest";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

const cipher = createSecretCipher("test-password");

describe("SecretCipher", () => {
  it("加解密往返", () => {
    const blob = cipher.encrypt('{"K":"v"}');
    expect(blob.startsWith("v1:")).toBe(true);
    expect(cipher.decrypt(blob)).toBe('{"K":"v"}');
  });
  it("密文篡改抛错（GCM tag 失败）", () => {
    const blob = cipher.encrypt("secret");
    const tampered = "v1:" + blob.slice(3).replace(/^./, "X");
    expect(() => cipher.decrypt(tampered)).toThrow();
  });
  it("缺 v1: 前缀抛错", () => {
    expect(() => cipher.decrypt("rawdata")).toThrow();
  });
  it("不同主密钥无法互解", () => {
    const other = createSecretCipher("other-password");
    const blob = other.encrypt("x");
    expect(() => cipher.decrypt(blob)).toThrow();
  });
  it("空 seed 抛错", () => {
    expect(() => createSecretCipher("")).toThrow();
  });
});
