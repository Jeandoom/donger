import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMessageFiles } from "../../src/domain/message-files.js";
import { materializeMessageFiles } from "../../src/orchestrator/attachment-materializer.js";

// 2026-09-28 方案A 回归锚点：agent 会话 cwd=agents/<agentId>/workspace 与附件目录
// sessions/<convId>/workspace/attachments 分离，`..` 相对路径模型照抄曾错层
// （生产实测 3 层抄成 9 层 → File does not exist，会话 cf94d5c8）。
// 物化 = 本轮引用的附件复制进 cwd 下 attachments/<conversationId>/，注入零 `..` 短路径。

describe("materializeMessageFiles", () => {
  let root: string;
  let cwd: string;
  let srcDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "donger-mat-"));
    cwd = join(root, "agents", "a1", "workspace");
    srcDir = join(root, "sessions", "c1", "workspace", "attachments");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("cwd 外的附件复制进 attachments/<convId>/ 并改写路径", () => {
    const src = join(srcDir, "1790597462741-image.png");
    writeFileSync(src, "hello");

    const out = materializeMessageFiles(
      [{ path: src, name: "image.png", type: "image" }],
      cwd,
      "c1",
    );

    const target = join(cwd, "attachments", "c1", "1790597462741-image.png");
    expect(out[0]?.path).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).size).toBe(5);
    // 原件不动（/uploads 预览数据源）
    expect(existsSync(src)).toBe(true);
  });

  it("已在 cwd 内的附件零拷贝跳过（会话会话常态）", () => {
    const inner = join(cwd, "notes.md");
    writeFileSync(inner, "hi");

    const out = materializeMessageFiles(
      [{ path: inner, name: "notes.md", type: "markdown" }],
      cwd,
      "c1",
    );

    expect(out[0]?.path).toBe(inner);
    expect(existsSync(join(cwd, "attachments"))).toBe(false);
  });

  it("重复物化幂等：同尺寸不重写", () => {
    const src = join(srcDir, "1-a.png");
    writeFileSync(src, "same-bytes");
    const [first] = materializeMessageFiles(
      [{ path: src, name: "a.png", type: "image" }],
      cwd,
      "c1",
    );
    if (!first) throw new Error("物化结果不应为空");
    const mtimeBefore = statSync(first.path).mtimeMs;

    materializeMessageFiles([{ path: src, name: "a.png", type: "image" }], cwd, "c1");

    expect(statSync(first.path).mtimeMs).toBe(mtimeBefore);
  });

  it("目标尺寸不符时重新物化（覆盖半写）", () => {
    const src = join(srcDir, "2-b.png");
    writeFileSync(src, "correct-content");
    const [first] = materializeMessageFiles(
      [{ path: src, name: "b.png", type: "image" }],
      cwd,
      "c1",
    );
    if (!first) throw new Error("物化结果不应为空");
    writeFileSync(first.path, "half"); // 模拟半写/损坏

    materializeMessageFiles([{ path: src, name: "b.png", type: "image" }], cwd, "c1");

    expect(statSync(first.path).size).toBe("correct-content".length);
  });

  it("源文件缺失时回退原路径，不阻断发消息", () => {
    const ghost = join(srcDir, "3-gone.png");
    const out = materializeMessageFiles(
      [{ path: ghost, name: "gone.png", type: "image" }],
      cwd,
      "c1",
    );
    expect(out[0]?.path).toBe(ghost);
  });

  it("conversationId 形态非法时不物化（路径拼装防御）", () => {
    const src = join(srcDir, "4-c.png");
    writeFileSync(src, "x");
    const out = materializeMessageFiles(
      [{ path: src, name: "c.png", type: "image" }],
      cwd,
      "..\\evil",
    );
    expect(out[0]?.path).toBe(src);
    expect(existsSync(join(cwd, "attachments"))).toBe(false);
  });

  it("与 appendMessageFiles 串联：注入 cwd 相对正斜杠路径且无 .. 与反斜杠转义", () => {
    const src = join(srcDir, "5-d.png");
    writeFileSync(src, "img");
    const [file] = materializeMessageFiles(
      [{ path: src, name: "d.png", type: "image" }],
      cwd,
      "c1",
    );
    if (!file) throw new Error("物化结果不应为空");
    const prompt = appendMessageFiles("看图", [file], cwd);

    expect(prompt).toContain("attachments/c1/5-d.png");
    expect(prompt).not.toContain("..\\");
    expect(prompt).not.toContain("\\\\");
  });
});
