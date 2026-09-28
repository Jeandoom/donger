import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { MessageFile } from "../domain/types.js";

/**
 * 附件物化（2026-09-28 方案A）：agent 会话的 cwd=agents/<agentId>/workspace 与附件落盘
 * 目录 sessions/<convId>/workspace/attachments 分离，注入路径含多层 `..`（cwd→用户根三层），
 * 模型照抄时错层（生产实测 3 层抄成 9 层 → File does not exist，会话 cf94d5c8）。
 * 本轮引用的附件复制进 cwd 下 attachments/<conversationId>/，注入一层深、零 `..` 的
 * cwd 相对路径。复制而非硬链：物化件是快照，agent 在 cwd 内改写不污染会话附件原件
 * （/uploads 回读与前端预览的数据源）。会话会话（无 agent）附件本就在 cwd 下，零拷贝跳过。
 */

const MATERIALIZED_DIR = "attachments";

/** conversationId 直接拼进 cwd 相对路径，格式防御（服务端生成的 UUID 应恒命中） */
const SAFE_ENTITY_ID = /^[\w-]+$/;

export function materializeMessageFiles(
  files: readonly MessageFile[],
  cwd: string,
  conversationId: string,
): MessageFile[] {
  return files.map((file) => {
    const abs = resolve(file.path);
    const rel = relative(cwd, abs);
    // 已在 cwd 内：无需物化（会话会话的常态）
    if (rel && !isAbsolute(rel) && !rel.startsWith("..")) return file;
    if (!SAFE_ENTITY_ID.test(conversationId)) return file;

    const targetDir = join(cwd, MATERIALIZED_DIR, conversationId);
    // basename 二次剥离目录分量：源文件名经上传消毒（sanitizeUploadName），此处双保险
    const target = join(targetDir, basename(abs));
    try {
      // 幂等：同尺寸跳过（重复引用/并发轮）；尺寸不符重物化（覆盖半写/原件更新）
      if (!existsSync(target) || statSync(target).size !== statSync(abs).size) {
        mkdirSync(targetDir, { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        copyFileSync(abs, tmp);
        renameSync(tmp, target);
      }
    } catch {
      // 物化失败不阻断本轮：回退原路径（维持相对化注入的旧行为）
      return file;
    }
    return { ...file, path: target };
  });
}
