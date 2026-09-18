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

/** 越权访问（路径穿越 / 跨用户 / 会话不属于该用户） */
export class ForbiddenError extends AppError {}

/** 资源不存在 */
export class NotFoundError extends AppError {}

/** 实体过大（超出预览/下载上限） */
export class PayloadTooLargeError extends AppError {}

/** 技能安装/卸载/更新错误 */
export class SkillInstallError extends AppError {}

/** 任务执行所需凭证缺失且无法经渠道收集 */
export class CredentialRequiredError extends AppError {}
