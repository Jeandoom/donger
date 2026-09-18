import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptValue, encryptValue } from "../../src/util/skill-crypto.js";

describe("skill-crypto", () => {
  it("加解密往返", () => {
    const key = randomBytes(32).toString("hex");
    const ct = encryptValue(key, "secret-token");
    expect(ct).not.toBe("secret-token");
    expect(decryptValue(key, ct)).toBe("secret-token");
  });

  it("密文每次不同（含随机 iv）", () => {
    const key = randomBytes(32).toString("hex");
    expect(encryptValue(key, "x")).not.toBe(encryptValue(key, "x"));
  });

  it("被篡改的密文解密抛错", () => {
    const key = randomBytes(32).toString("hex");
    const ct = encryptValue(key, "v");
    expect(() => decryptValue(key, `${ct.slice(0, -2)}AB`)).toThrow();
  });
});
