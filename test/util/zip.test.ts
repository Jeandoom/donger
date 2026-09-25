import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/util/errors.js";
import { extractZipToDir } from "../../src/util/zip.js";

/**
 * 测试专用最小 zip 构造器（STORE 无压缩形态）：
 * local header + data ×n → central directory ×n → EOCD。
 * 支持注入 versionMadeBy/externalAttrs/伪造 uncompSize（炸弹防护用例）。
 */
interface ZipEntrySpec {
  name: string;
  data?: Buffer;
  versionMadeBy?: number;
  externalAttrs?: number;
  claimedUncompSize?: number;
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const nameBuf = Buffer.from(e.name, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    locals.push(local);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(e.versionMadeBy ?? (3 << 8) | 20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(e.claimedUncompSize ?? data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(e.externalAttrs ?? 0o100000 * 0x10000),
      u32(offset),
      nameBuf,
    ]);
    centrals.push(central);
    offset += local.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(cdStart),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "zip-test-"));
}

describe("zip 解包器（应用 bundle 上传链路）", () => {
  it("正常提取：文件与目录结构落盘，返回统计", () => {
    const dir = tmpDir();
    const zip = buildZip([
      { name: "index.html", data: Buffer.from("<html>ok</html>") },
      { name: "assets/app.js", data: Buffer.from("console.log(1)") },
      { name: "assets/", data: Buffer.alloc(0) },
    ]);
    const r = extractZipToDir(zip, dir);
    expect(r.fileCount).toBe(2);
    expect(r.totalBytes).toBe(15 + 14);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("<html>ok</html>");
    expect(readFileSync(join(dir, "assets/app.js"), "utf8")).toBe("console.log(1)");
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("路径穿越条目（../）拒绝", () => {
    const dir = tmpDir();
    const zip = buildZip([{ name: "../evil.txt", data: Buffer.from("x") }]);
    expect(() => extractZipToDir(zip, dir)).toThrow(ValidationError);
    expect(existsSync(join(dir, "..", "evil.txt"))).toBe(false);
  });

  it("绝对路径与盘符条目拒绝", () => {
    const dir = tmpDir();
    expect(() =>
      extractZipToDir(buildZip([{ name: "/abs/evil.txt", data: Buffer.from("x") }]), dir),
    ).toThrow(ValidationError);
    expect(() =>
      extractZipToDir(buildZip([{ name: "C:evil.txt", data: Buffer.from("x") }]), dir),
    ).toThrow(ValidationError);
  });

  it("符号链接条目拒绝（unix externalAttrs）", () => {
    const dir = tmpDir();
    const zip = buildZip([
      { name: "link", data: Buffer.from("/etc/passwd"), externalAttrs: 0o120777 * 0x10000 },
    ]);
    expect(() => extractZipToDir(zip, dir)).toThrow(ValidationError);
  });

  it("非 zip 输入拒绝", () => {
    const dir = tmpDir();
    expect(() => extractZipToDir(Buffer.from("definitely not a zip"), dir)).toThrow(
      ValidationError,
    );
  });

  it("zip 炸弹防护：伪造超大声明尺寸中止", () => {
    const dir = tmpDir();
    const zip = buildZip([
      { name: "bomb.bin", data: Buffer.alloc(4), claimedUncompSize: 0xfffffff0 },
    ]);
    expect(() => extractZipToDir(zip, dir)).toThrow(ValidationError);
  });
});
