import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import {
  buildCron,
  defaultFields,
  defaultPreset,
  describeCron,
  FIELD_META,
  matchPreset,
  parseFieldsFromExpr,
  serializeField,
  validateCron,
  WEEK_DAY_LABELS,
  type FieldState,
  type PresetKind,
  type PresetState,
} from "../lib/cronBuilder";

const PRESET_OPTIONS: Array<{ value: PresetKind | "raw"; label: string }> = [
  { value: "everyNMinutes", label: "每隔 N 分钟" },
  { value: "everyNHours", label: "每隔 N 小时" },
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "yearly", label: "每年" },
  { value: "custom", label: "自定义（高级）" },
  { value: "raw", label: "表达式直输" },
];

interface CronBuilderProps {
  value: string;
  onChange: (expr: string) => void;
}

/**
 * Cron 交互式配置（spec §5.1；2026-10-19 单一真源修订）：预设模式覆盖常见形态；
 * 高级模式五字段逐字段四模式（每/范围/列表/步进）笛卡尔组合可表达全部标准 5 字段 cron；
 * 表达式框可直接编辑（直输模式）。受控组件：value=cron 字符串，onChange 回传表达式。
 *
 * 单一真源：外部 value 变化（页面加载/回填）且非本组件刚上抛的值时，反填内部状态——
 * 显示恒等于真实存储值；否则编辑页会显示组件默认值（如每天 9:00）造成「没保存上」假象，
 * 且一动控件即整体覆写真实表达式。无法反填的表达式落直输模式保留原文。
 */
export function CronBuilder({ value, onChange }: CronBuilderProps) {
  const [preset, setPreset] = useState<PresetState>(defaultPreset);
  const [fields, setFields] = useState(defaultFields);
  const [mode, setMode] = useState<"preset" | "custom" | "raw">("preset");
  const [manual, setManual] = useState<string | null>(null);
  const seenValueRef = useRef(value);
  const emittedRef = useRef<string | null>(null);

  /** 以表达式反填内部状态：预设反填 → 高级五字段 → 直输原文（三级尽力） */
  const backfill = (expr: string) => {
    const matched = matchPreset(expr);
    if (matched) {
      setPreset(matched);
      setMode("preset");
      setManual(null);
      return;
    }
    const parsed = parseFieldsFromExpr(expr);
    if (parsed) {
      setFields(parsed);
      setMode("custom");
      setManual(null);
      return;
    }
    setMode("raw");
    setManual(expr);
  };

  useEffect(() => {
    if (value === seenValueRef.current) return;
    seenValueRef.current = value;
    if (value === emittedRef.current) return; // 本组件刚上抛的回流，不重置
    backfill(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const generated = useMemo(
    () => (mode === "preset" ? buildCron(preset, fields) : (manual ?? value)),
    [mode, preset, fields, manual, value],
  );
  const error = validateCron(generated);
  const description = error ? "表达式非法" : describeCron(generated);

  const emit = (expr: string) => {
    emittedRef.current = expr;
    onChange(expr);
  };

  const applyPreset = (kind: PresetKind) => {
    const current = manual ?? value;
    if (kind === "custom") {
      // 进入高级模式：以当前表达式反填字段（保留既有配置），解析不了才落默认值
      const parsed = parseFieldsFromExpr(current);
      if (parsed) setFields(parsed);
      setMode("custom");
      setManual(null);
      setPreset((p) => ({ ...p, kind }));
      return;
    }
    setPreset((p) => ({ ...p, kind }));
    setMode("preset");
    setManual(null);
    emit(buildCron({ ...preset, kind }, fields));
  };

  const updatePreset = (patch: Partial<PresetState>) => {
    const next = { ...preset, ...patch };
    setPreset(next);
    emit(buildCron(next, fields));
  };

  const updateField = (key: string, patch: Partial<FieldState>) => {
    const next = { ...fields, [key]: { ...fields[key as keyof typeof fields], ...patch } };
    setFields(next);
    if (mode === "custom") {
      const expr = FIELD_META.map((meta) => serializeField(next[meta.key], meta.min, meta.max)).join(" ");
      setManual(expr);
      emit(expr);
    }
  };

  const editRaw = (text: string) => {
    setMode("raw");
    setManual(text);
    emit(text);
  };

  const loadFromExpr = () => {
    // 以当前表达式反填高级编辑器（尽力解析；解析不了的段保留原值提示手改）
    const parts = (manual ?? value).trim().split(/\s+/);
    if (parts.length !== 5) return;
    const parsed = parseFieldsFromExpr(manual ?? value);
    if (parsed) setFields(parsed);
    setMode("custom");
  };

  const selectValue: PresetKind | "raw" = mode === "raw" ? "raw" : preset.kind;

  return (
    <div className="space-y-2.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Select
          aria-label="定时模式"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value as PresetKind | "raw";
            if (v === "raw") editRaw(manual ?? value);
            else applyPreset(v);
          }}
        >
          {PRESET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Input
          mono
          value={generated}
          aria-label="Cron 表达式"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          onChange={(e) => editRaw(e.target.value)}
        />
      </div>

      {preset.kind === "everyNMinutes" && (
        <>
          <NumberRow
            label="间隔（分钟）"
            min={1}
            max={59}
            value={preset.n}
            onChange={(n) => updatePreset({ n })}
          />
          {preset.n > 59 && (
            <p className="text-xs text-destructive">
              间隔上限 59 分钟（当前按 59 生效）；更长周期请改用「每隔 N 小时」或自定义。
            </p>
          )}
        </>
      )}
      {preset.kind === "everyNHours" && (
        <>
          <NumberRow
            label="间隔（小时）"
            min={1}
            max={23}
            value={preset.nHours}
            onChange={(nHours) => updatePreset({ nHours })}
          />
          <NumberRow
            label="第几分钟"
            min={0}
            max={59}
            value={preset.minute}
            onChange={(minute) => updatePreset({ minute })}
          />
        </>
      )}
      {preset.kind === "hourly" && (
        <NumberRow
          label="第几分钟"
          min={0}
          max={59}
          value={preset.minute}
          onChange={(minute) => updatePreset({ minute })}
        />
      )}
      {preset.kind === "daily" && (
        <TimeRow hour={preset.hour} minute={preset.minute} onChange={updatePreset} />
      )}
      {preset.kind === "weekly" && (
        <>
          <CheckRow
            label="星期"
            options={WEEK_DAY_LABELS.map((label, i) => ({ value: i, label: `周${label}` }))}
            selected={preset.weekDays}
            onChange={(weekDays) => updatePreset({ weekDays })}
          />
          <TimeRow hour={preset.hour} minute={preset.minute} onChange={updatePreset} />
        </>
      )}
      {preset.kind === "monthly" && (
        <>
          <CheckRow
            label="日期"
            options={Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1}` }))}
            selected={preset.monthDays}
            onChange={(monthDays) => updatePreset({ monthDays })}
          />
          <TimeRow hour={preset.hour} minute={preset.minute} onChange={updatePreset} />
        </>
      )}
      {preset.kind === "yearly" && (
        <>
          <div className="grid gap-2.5 sm:grid-cols-3">
            <NumberRow
              label="月"
              min={1}
              max={12}
              value={preset.month}
              onChange={(month) => updatePreset({ month })}
            />
            <NumberRow
              label="日"
              min={1}
              max={31}
              value={preset.monthDay}
              onChange={(monthDay) => updatePreset({ monthDay })}
            />
          </div>
          <TimeRow hour={preset.hour} minute={preset.minute} onChange={updatePreset} />
        </>
      )}
      {(preset.kind === "custom" || mode === "custom") && (
        <div className="space-y-2.5 rounded-lg border border-border p-3">
          {FIELD_META.map((meta) => {
            const f = fields[meta.key];
            return (
              <div key={meta.key} className="grid items-center gap-2 sm:grid-cols-[4rem_8rem_1fr]">
                <span className="text-xs text-muted-foreground">{meta.label}</span>
                <Select
                  aria-label={`${meta.label}模式`}
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as FieldState["type"];
                    updateField(meta.key, { type });
                  }}
                >
                  <option value="every">每（*）</option>
                  <option value="range">范围</option>
                  <option value="step">步进</option>
                  <option value="list">指定值</option>
                </Select>
                <div className="flex flex-wrap items-center gap-1.5">
                  {f.type === "range" && (
                    <>
                      <NumInput
                        label="从"
                        value={f.from}
                        min={meta.min}
                        max={meta.max}
                        onChange={(from) => updateField(meta.key, { from })}
                      />
                      <NumInput
                        label="到"
                        value={f.to}
                        min={meta.min}
                        max={meta.max}
                        onChange={(to) => updateField(meta.key, { to })}
                      />
                      <NumInput
                        label="步长"
                        value={f.step}
                        min={1}
                        max={meta.max}
                        onChange={(step) => updateField(meta.key, { step })}
                      />
                    </>
                  )}
                  {f.type === "step" && (
                    <NumInput
                      label="每"
                      value={f.step}
                      min={1}
                      max={meta.max}
                      onChange={(step) => updateField(meta.key, { step })}
                    />
                  )}
                  {f.type === "list" && (
                    <input
                      aria-label={`${meta.label}列表`}
                      className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                      placeholder={`逗号分隔（${meta.min}-${meta.max}）`}
                      defaultValue={f.list.join(",")}
                      onBlur={(e) => {
                        const list = e.target.value
                          .split(",")
                          .map((v) => Number(v.trim()))
                          .filter((v) => Number.isInteger(v));
                        updateField(meta.key, { list });
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            五段分别为 分钟(0-59) 小时(0-23) 日(1-31) 月(1-12) 星期(0-7, 0=周日)；
            范围+步长可表达工作时段周期（如小时 9-18 步长 4 = 9-18 点每 4 小时）。
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={error ? "text-destructive" : "text-muted-foreground"}>
          {description}
          {error ? `：${error}` : ""}
        </span>
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={loadFromExpr}
        >
          按表达式编辑
        </button>
      </div>
    </div>
  );
}

function NumInput(props: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      {props.label}
      <Input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-20"
      />
    </label>
  );
}

function NumberRow(props: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <Input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-24"
      />
    </div>
  );
}

function TimeRow(props: {
  hour: number;
  minute: number;
  onChange: (patch: { hour?: number; minute?: number }) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">时间</span>
      <Input
        type="time"
        value={`${String(props.hour).padStart(2, "0")}:${String(props.minute).padStart(2, "0")}`}
        onChange={(e) => {
          const [h, m] = e.target.value.split(":").map(Number);
          props.onChange({ hour: h || 0, minute: m || 0 });
        }}
        className="w-32"
      />
    </div>
  );
}

function CheckRow(props: {
  label: string;
  options: Array<{ value: number; label: string }>;
  selected: number[];
  onChange: (values: number[]) => void;
}) {
  const toggle = (v: number) => {
    const next = props.selected.includes(v)
      ? props.selected.filter((x) => x !== v)
      : [...props.selected, v];
    props.onChange(next.length ? next : props.selected);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-24 shrink-0 text-xs text-muted-foreground">{props.label}</span>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => toggle(o.value)}
          className={`rounded-md border px-2 py-1 text-xs ${
            props.selected.includes(o.value)
              ? "border-primary bg-primary-soft text-primary"
              : "border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
