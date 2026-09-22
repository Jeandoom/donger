/**
 * 修订账本的行级 diff（spec §6.2）：自实现、不引第三方依赖。
 * 策略 = 最长公共前/后缀行剥离 + 中段 -/+ 块 + 前后 3 行上下文（unified 风格），超 maxBytes 截断。
 */

const CONTEXT_LINES = 3;

export function lineDiff(before: string, after: string, maxBytes = 64_000): string {
  const a = before.length === 0 ? [] : before.split(/\r?\n/);
  const b = after.length === 0 ? [] : after.split(/\r?\n/);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ctxHead = a.slice(Math.max(0, prefix - CONTEXT_LINES), prefix);
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  // 内容无变化：空 diff（调用方据此跳过 config 修订）
  if (removed.length === 0 && added.length === 0) return "";
  const ctxTail = a.slice(a.length - suffix, Math.min(a.length - suffix + CONTEXT_LINES, a.length));

  const aStart = Math.max(0, prefix - CONTEXT_LINES) + 1;
  const bStart = Math.max(0, prefix - CONTEXT_LINES) + 1;
  const aCount = ctxHead.length + removed.length + ctxTail.length;
  const bCount = ctxHead.length + added.length + ctxTail.length;

  const lines: string[] = [`@@ -${aStart},${aCount} +${bStart},${bCount} @@`];
  for (const l of ctxHead) lines.push(` ${l}`);
  for (const l of removed) lines.push(`-${l}`);
  for (const l of added) lines.push(`+${l}`);
  for (const l of ctxTail) lines.push(` ${l}`);

  let out = lines.join("\n");
  if (out.length > maxBytes) out = `${out.slice(0, maxBytes)}\n…（diff 已截断）`;
  return out;
}
