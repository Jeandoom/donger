import { describe, expect, it } from "vitest";
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
    // 首字符恰好为 "X" 时换成别的字符（1/64 概率 replace 无效 = 密文未变不抛错）
    const tampered = `v1:${blob.slice(3).replace(/^./, blob.slice(3, 4) === "X" ? "Y" : "X")}`;
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
