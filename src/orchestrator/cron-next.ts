/**
 * 轻量 cron 下次触发时间计算 + 表达式校验（node-cron 无 next 接口；调度本体仍由
 * node-cron 承担，本模块只服务「下次触发」展示与 CronBuilder 前端同构校验）。
 * 支持 5 字段标准语法（* , - / 与数字）；逐分钟步进探测，上限 366 天。
 */

type Field = { values: Set<number>; wildcard: boolean };

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function parseField(expr: string, min: number, max: number): Field | null {
  const values = new Set<number>();
  let wildcard = false;
  for (const part of expr.split(",")) {
    const m = part.match(/^(\*|-?\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return null;
    const [, a, b, stepStr] = m;
    if (a === "*" && b !== undefined) return null;
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (a === "*") {
      if (stepStr === undefined) wildcard = true;
      lo = min;
      hi = max;
    } else {
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size > 0 ? { values, wildcard } : null;
}

export function validateCronExpr(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parseCron(expr) !== null;
}

export interface CronFields {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const maybe = parseField(parts[0] ?? "", RANGES[0][0], RANGES[0][1]);
  const minute = maybe ?? null;
  const hour = parseField(parts[1] ?? "", RANGES[1][0], RANGES[1][1]) ?? null;
  const dom = parseField(parts[2] ?? "", RANGES[2][0], RANGES[2][1]) ?? null;
  const month = parseField(parts[3] ?? "", RANGES[3][0], RANGES[3][1]) ?? null;
  const dow = parseField(parts[4] ?? "", RANGES[4][0], RANGES[4][1]) ?? null;
  if (!minute || !hour || !dom || !month || !dow) return null;
  for (const v of [...dow.values]) {
    if (v === 7) dow.values.add(0); // 0/7 都表示周日
  }
  return { minute, hour, dom, month, dow };
}

/** expr 在 from 之后的下一次触发时刻（ISO 字符串）；366 天内无命中返回 null */
export function nextCronFire(expr: string, from: Date = new Date()): string | null {
  const f = parseCron(expr);
  if (!f) return null;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3600 * 1000;
  while (cursor.getTime() <= limit) {
    if (
      f.minute.values.has(cursor.getMinutes()) &&
      f.hour.values.has(cursor.getHours()) &&
      f.month.values.has(cursor.getMonth() + 1) &&
      matchDay(f, cursor)
    ) {
      return cursor.toISOString();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** POSIX cron 语义：dom 与 dow 均受限（非 *）时取并集，其一为 * 时取交集 */
function matchDay(f: CronFields, d: Date): boolean {
  const domHit = f.dom.values.has(d.getDate());
  const dowHit = f.dow.values.has(d.getDay());
  if (f.dom.wildcard && f.dow.wildcard) return true;
  if (f.dom.wildcard) return dowHit;
  if (f.dow.wildcard) return domHit;
  return domHit || dowHit;
}
