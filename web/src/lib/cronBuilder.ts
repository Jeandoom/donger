/**
 * Cron 交互式配置纯逻辑（spec 2026-10-09-events-workflows-refactor-design §5.1）：
 * 预设模式 + 高级五字段编辑器，笛卡尔组合覆盖全部标准 5 字段 cron 表达力；
 * 只生成数字与 * , - / 表达式（规避 node-cron 方言）。与后端 cron-next.ts 同构校验。
 */

export type PresetKind =
  | "everyNMinutes"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "custom";

export interface PresetState {
  kind: PresetKind;
  n: number; // everyNMinutes
  minute: number; // hourly/daily/weekly/monthly/yearly
  hour: number; // daily/weekly/monthly/yearly
  weekDays: number[]; // weekly（0=周日）
  monthDays: number[]; // monthly
  month: number; // yearly
  monthDay: number; // yearly
}

export interface FieldState {
  type: "every" | "range" | "list" | "step";
  from: number;
  to: number;
  step: number;
  list: number[];
}

export const FIELD_META: Array<{
  key: "minute" | "hour" | "dom" | "month" | "dow";
  label: string;
  min: number;
  max: number;
}> = [
  { key: "minute", label: "分钟", min: 0, max: 59 },
  { key: "hour", label: "小时", min: 0, max: 23 },
  { key: "dom", label: "日", min: 1, max: 31 },
  { key: "month", label: "月", min: 1, max: 12 },
  { key: "dow", label: "星期", min: 0, max: 7 },
];

export const WEEK_DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export const defaultPreset = (): PresetState => ({
  kind: "daily",
  n: 5,
  minute: 0,
  hour: 9,
  weekDays: [1],
  monthDays: [1],
  month: 1,
  monthDay: 1,
});

export const defaultFields = (): Record<(typeof FIELD_META)[number]["key"], FieldState> => ({
  minute: { type: "every", from: 0, to: 59, step: 1, list: [0] },
  hour: { type: "every", from: 0, to: 23, step: 1, list: [0] },
  dom: { type: "every", from: 1, to: 31, step: 1, list: [1] },
  month: { type: "every", from: 1, to: 12, step: 1, list: [1] },
  dow: { type: "every", from: 0, to: 7, step: 1, list: [1] },
});

const pad = (n: number): string => String(n).padStart(2, "0");
const time = (h: number, m: number): string => `${pad(h)}:${pad(m)}`;

/** 预设/高级状态 → cron 表达式（只产数字与 * , - /） */
export function buildCron(preset: PresetState, fields: ReturnType<typeof defaultFields>): string {
  if (preset.kind === "custom") {
    return FIELD_META.map((meta) => serializeField(fields[meta.key], meta.min, meta.max)).join(" ");
  }
  switch (preset.kind) {
    case "everyNMinutes":
      return `*/${clamp(preset.n, 1, 59)} * * * *`;
    case "hourly":
      return `${clamp(preset.minute, 0, 59)} * * * *`;
    case "daily":
      return `${clamp(preset.minute, 0, 59)} ${clamp(preset.hour, 0, 23)} * * *`;
    case "weekly": {
      const days = normalizeList(preset.weekDays, 0, 6);
      return `${clamp(preset.minute, 0, 59)} ${clamp(preset.hour, 0, 23)} * * ${
        days.length ? days.join(",") : "1"
      }`;
    }
    case "monthly": {
      const days = normalizeList(preset.monthDays, 1, 31);
      return `${clamp(preset.minute, 0, 59)} ${clamp(preset.hour, 0, 23)} ${
        days.length ? days.join(",") : "1"
      } * *`;
    }
    case "yearly":
      return `${clamp(preset.minute, 0, 59)} ${clamp(preset.hour, 0, 23)} ${clamp(
        preset.monthDay,
        1,
        31,
      )} ${clamp(preset.month, 1, 12)} *`;
  }
}

function serializeField(f: FieldState, min: number, max: number): string {
  switch (f.type) {
    case "every":
      return "*";
    case "range":
      return `${clamp(f.from, min, max)}-${clamp(f.to, min, max)}`;
    case "step":
      return `*/${clamp(f.step, 1, max)}`;
    case "list": {
      const list = normalizeList(f.list, min, max);
      return list.length ? list.join(",") : "*";
    }
  }
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(v) ? v : lo)));

function normalizeList(list: number[], min: number, max: number): number[] {
  return [...new Set(list.map((v) => clamp(v, min, max)))].sort((a, b) => a - b);
}

/** 客户端同构校验（与后端 cron-next.ts 同规则）：合法返回 null，非法返回错误文案 */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "表达式须为 5 段（分 时 日 月 周）";
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  for (let i = 0; i < 5; i++) {
    if (!parseFieldOk(parts[i]!, ranges[i]![0], ranges[i]![1])) {
      return `第 ${i + 1} 段（${FIELD_META[i]!.label}）非法`;
    }
  }
  return null;
}

function parseFieldOk(expr: string, min: number, max: number): boolean {
  for (const part of expr.split(",")) {
    const m = part.match(/^(\*|-?\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return false;
    const [, a, b, stepStr] = m;
    if (a === "*" && b !== undefined) return false;
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let lo: number;
    let hi: number;
    if (a === "*") {
      lo = min;
      hi = max;
    } else {
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
      return false;
  }
  return true;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 人类可读描述：识别常见形态给中文，其余给「自定义」+表达式（展示侧已有表达式本体） */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "自定义";
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const at = (mm: string, hh: string): string =>
    `每天 ${pad2(Number(hh))}:${pad2(Number(mm))}`;
  if (m === "*") return "每分钟";
  if (/^\*\/\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `每 ${m.slice(2)} 分钟`;
  }
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `每小时第 ${m} 分`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && dow === "*") {
    return at(m, h);
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && /^\d+(,\d+)*$/.test(dow)) {
    const days = dow.split(",").map((d) => `周${WEEK_DAY_LABELS[Number(d) % 7] ?? d}`);
    return `每${days.join("、")} ${pad2(Number(h))}:${pad2(Number(m))}`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+(,\d+)*$/.test(dom) && mon === "*" && dow === "*") {
    const days = dom.split(",").map((d) => `${d} 号`);
    return `每月${days.join("、")} ${pad2(Number(h))}:${pad2(Number(m))}`;
  }
  if (
    /^\d+$/.test(m) &&
    /^\d+$/.test(h) &&
    /^\d+$/.test(dom) &&
    /^\d+$/.test(mon) &&
    dow === "*"
  ) {
    return `每年 ${mon} 月 ${dom} 日 ${pad2(Number(h))}:${pad2(Number(m))}`;
  }
  return "自定义";
}

export const formatTime = time;
