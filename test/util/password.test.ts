import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/util/password.js";

describe("password scrypt 哈希", () => {
  it("hash 后可 verify", () => {
    const stored = hashPassword("abc12345");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("abc12345", stored)).toBe(true);
  });

  it("错误密码 → false", () => {
    const stored = hashPassword("abc12345");
    expect(verifyPassword("wrong123", stored)).toBe(false);
  });

  it("同一密码两次 hash 产生不同 salt", () => {
    expect(hashPassword("abc12345")).not.toBe(hashPassword("abc12345"));
  });

  it("畸形存储串 → false（不抛错）", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "plaintext")).toBe(false);
    expect(verifyPassword("x", "bcrypt$aa$bb")).toBe(false);
  });
});
