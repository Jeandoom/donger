/**
 * 应用错误基类：code（字符串）+ message + cause。
 * 子类通过 `new.target.name` 自动设置 name，便于按类型分类与日志归因。
 */
import type { ZodError, ZodIssue } from "zod";

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

/**
 * ZodError → 单行可读文案（字段路径 + 中文原因）。裸 e.message 是 issue 数组的
 * JSON 串，前端红条里不可读，用户感知即「保存不了但不知道为什么」。
 */
export function describeZodError(e: ZodError): string {
  const part = (issue: ZodIssue): string => {
    const path = issue.path
      .filter((p) => typeof p === "string" || typeof p === "number")
      .join(".");
    const where = path ? `${path} ` : "";
    switch (issue.code) {
      case "custom":
        return `${where}${issue.message}`; // refine 文案本身已是中文
      case "invalid_type":
        return `${where}类型不正确`;
      case "too_small":
        return `${where}取值过小`;
      case "too_big":
        return `${where}取值过大`;
      default:
        return `${where}${issue.message}`;
    }
  };
  const parts = e.issues.slice(0, 3).map(part);
  const more = e.issues.length > 3 ? ` 等 ${e.issues.length} 处` : "";
  return `参数校验未通过：${parts.join("；")}${more}`;
}
