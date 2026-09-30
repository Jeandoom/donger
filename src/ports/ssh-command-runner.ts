// SSH 命令执行端口：部署执行器与 donger-host 工具的唯一远程执行通道。
// 依赖注入形态——生产接 ssh2 适配器（adapters/ssh2-command-runner.ts），测试注入桩。

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
}

export interface SshAuthMaterial {
  privateKey?: string;
  password?: string;
}

export interface SshCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SshCommandOptions {
  /** 单命令超时毫秒（缺省 120s；超时按失败处理并断开连接） */
  timeoutMs?: number;
  /** 单命令输出捕获上限字符（缺省 200k，防内存放大） */
  maxOutputChars?: number;
}

export type SshCommandRunner = (
  endpoint: SshEndpoint,
  auth: SshAuthMaterial,
  command: string,
  opts?: SshCommandOptions,
) => Promise<SshCommandResult>;
