import pino from "pino";
import type { LogLevel } from "../config.js";

/** 日志器类型 = pino.Logger（直接复用 pino 全套 API：child / 级别 / 传输） */
export type Logger = pino.Logger;

/**
 * 创建日志器。
 * @param level 最低输出级别（来自配置）
 * @param scope 作用域标签，注入到每条日志的 scope 字段
 * @param destination 输出流（默认 stdout），便于测试注入
 */
export function createLogger(
  level: LogLevel,
  scope = "app",
  destination: pino.DestinationStream = process.stdout,
): Logger {
  return pino({ level }, destination).child({ scope });
}
