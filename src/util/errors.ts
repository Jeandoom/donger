/**
 * 应用错误基类：code（字符串）+ message + cause。
 * 子类通过 `new.target.name` 自动设置 name，便于按类型分类与日志归因。
 */
export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 配置错误（env 缺失/非法等） */
export class ConfigError extends AppError {}

/** 任务生命周期错误 */
export class TaskError extends AppError {}

/** 渠道（IM）错误 */
export class ChannelError extends AppError {}

/** 执行引擎（AgentRunner）错误 */
export class RunnerError extends AppError {}

/** 输入/数据校验错误 */
export class ValidationError extends AppError {}
