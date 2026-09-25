import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { APP_BUNDLE_MAX_ENTRIES, APP_BUNDLE_TOTAL_UNCOMPRESSED_MAX } from "../domain/app.js";
import { ValidationError } from "./errors.js";

/**
 * 最小 ZIP 解包器（零依赖；spec 2026-09-25-app-platform-architecture §5 RT-A）。
 *
 * 只实现应用产物 bundle 需要的子集：STORE / DEFLATE、单盘、无加密。
 * 安全不变量：
 *  - 路径穿越拒绝（.. / 绝对路径 / 盘符 / 反斜杠归一后复检 resolve 包含性）
 *  - 符号链接与加密条目拒绝（zip-slip 与落盘逃逸）
 *  - 条目数与解压总量上限（zip 炸弹防护，超限即中止抛 ValidationError）
 */

export interface ZipEntryInfo {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttrs: number;
  versionMadeBy: number;
}

export interface ZipExtractResult {
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOH_SIG = 0x04034b50;

export function extractZipToDir(zip: Buffer, destDir: string): ZipExtractResult {
  const central = readCentralDirectory(zip);
  if (central.length > APP_BUNDLE_MAX_ENTRIES) {
    throw new ValidationError("INVALID_BUNDLE", `bundle 条目数超过上限 ${APP_BUNDLE_MAX_ENTRIES}`);
  }

  mkdirSync(destDir, { recursive: true });
  const hash = createHash("sha256");
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of central) {
    if (entry.flags & 0b1)
      throw new ValidationError("INVALID_BUNDLE", `加密条目不支持: ${entry.name}`);
    const name = normalizeEntryName(entry.name);
    if (name === null) throw new ValidationError("INVALID_BUNDLE", `非法条目路径: ${entry.name}`);

    // 目录条目（/ 结尾）：仅建目录
    if (name.endsWith("/")) {
      mkdirSync(join(destDir, name), { recursive: true });
      continue;
    }

    // Unix 外部属性高位为 mode：符号链接/设备一律拒绝（防落盘逃逸）
    const isUnix = entry.versionMadeBy >> 8 === 3;
    if (isUnix) {
      const mode = (entry.externalAttrs >> 16) & 0o170000;
      if (mode !== 0 && mode !== 0o100000) {
        throw new ValidationError("INVALID_BUNDLE", `非常规文件条目不支持: ${entry.name}`);
      }
    }

    if (totalBytes + entry.uncompressedSize > APP_BUNDLE_TOTAL_UNCOMPRESSED_MAX) {
      throw new ValidationError("INVALID_BUNDLE", "bundle 解压总量超过上限");
    }

    const content = readEntryContent(zip, entry);
    if (content.length !== entry.uncompressedSize) {
      throw new ValidationError("INVALID_BUNDLE", `条目大小不符: ${entry.name}`);
    }
    const abs = resolve(join(destDir, name));
    if (!abs.startsWith(resolve(destDir) + sep)) {
      throw new ValidationError("INVALID_BUNDLE", `条目路径越界: ${entry.name}`);
    }
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    hash.update(name);
    hash.update(content);
    totalBytes += content.length;
    fileCount += 1;
  }

  return { fileCount, totalBytes, sha256: hash.digest("hex") };
}

/** 归一化条目名；非法（穿越/绝对路径/空）返回 null；目录条目保留结尾 / */
function normalizeEntryName(raw: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符正是要拒绝的对象
  if (/[\u0000-\u001f]/.test(raw)) return null;
  const unified = raw.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const parts = unified.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  if (out.length === 0) return unified.endsWith("/") ? "" : null;
  return out.join("/") + (unified.endsWith("/") ? "/" : "");
}

function readCentralDirectory(zip: Buffer): ZipEntryInfo[] {
  const eocd = findEocd(zip);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntryInfo[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > zip.length || view.getUint32(offset, true) !== CEN_SIG) {
      throw new ValidationError("INVALID_BUNDLE", "zip 中央目录损坏");
    }
    entries.push({
      name: zip
        .subarray(offset + 46, offset + 46 + view.getUint16(offset + 28, true))
        .toString("utf8"),
      method: view.getUint16(offset + 10, true),
      flags: view.getUint16(offset + 8, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
      externalAttrs: view.getUint32(offset + 38, true),
      versionMadeBy: view.getUint16(offset + 4, true),
    });
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return entries;
}

/** 从尾部向前扫 EOCD（注释长度不定，最多回扫 64KB+22） */
function findEocd(zip: Buffer): number {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      const disk = zip.readUInt16LE(i + 4);
      if (disk !== 0) throw new ValidationError("INVALID_BUNDLE", "多盘 zip 不支持");
      return i;
    }
  }
  throw new ValidationError("INVALID_BUNDLE", "不是有效的 zip 文件");
}

function readEntryContent(zip: Buffer, entry: ZipEntryInfo): Buffer {
  if (
    entry.localHeaderOffset + 30 > zip.length ||
    zip.readUInt32LE(entry.localHeaderOffset) !== LOH_SIG
  ) {
    throw new ValidationError("INVALID_BUNDLE", `zip 局部头损坏: ${entry.name}`);
  }
  const nameLen = zip.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = zip.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const data = zip.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new ValidationError("INVALID_BUNDLE", `不支持的压缩方法 ${entry.method}: ${entry.name}`);
}

// ---------------------------------------------------------------------------
// ZIP 写入（app_deploy 工具的 bundle 打包；DEFLATE 形态，与上方读取器互逆）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const idx = (c ^ byte) & 0xff;
    c = (CRC_TABLE[idx] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

/** 递归收集目录下普通文件（相对路径正斜杠形态）；symlink 跳过（防打包逃逸内容） */
function walkFiles(root: string, dir = "", out: Array<{ rel: string; abs: string }> = []) {
  const base = join(root, dir);
  for (const entry of readdirSync(base)) {
    const rel = dir ? `${dir}/${entry}` : entry;
    const abs = join(base, entry);
    const st = statSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkFiles(root, rel, out);
    else if (st.isFile()) out.push({ rel, abs });
  }
  return out;
}

/**
 * 把目录打包为 zip Buffer（DEFLATE）。条目数与解压总量受 APP_BUNDLE_* 上限约束；
 * 空目录不表达（zip 目录条目省略，解包端逐级 mkdir）。
 */
export function zipDirToBuffer(dir: string): Buffer {
  const root = resolve(dir);
  const files = walkFiles(root);
  if (files.length > APP_BUNDLE_MAX_ENTRIES) {
    throw new ValidationError("BUNDLE_TOO_LARGE", `条目数超过上限 ${APP_BUNDLE_MAX_ENTRIES}`);
  }
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let total = 0;
  for (const f of files) {
    const content = readFileSync(f.abs);
    total += content.length;
    if (total > APP_BUNDLE_TOTAL_UNCOMPRESSED_MAX) {
      throw new ValidationError("BUNDLE_TOO_LARGE", "解压总量超过上限");
    }
    const nameBuf = Buffer.from(f.rel.replaceAll("\\", "/"), "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content);
    const local = Buffer.concat([
      u32le(0x04034b50),
      u16le(20),
      u16le(0x0800), // UTF-8 文件名
      u16le(8), // DEFLATE
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(compressed.length),
      u32le(content.length),
      u16le(nameBuf.length),
      u16le(0),
      nameBuf,
      compressed,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32le(0x02014b50),
        u16le((3 << 8) | 20), // unix
        u16le(20),
        u16le(0x0800),
        u16le(8),
        u16le(0),
        u16le(0),
        u32le(crc),
        u32le(compressed.length),
        u32le(content.length),
        u16le(nameBuf.length),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0o100644 * 0x10000),
        u32le(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(files.length),
    u16le(files.length),
    u32le(cd.length),
    u32le(cdStart),
    u16le(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 供测试断言产物落盘形态（普通文件判定） */
export function isRegularFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}
