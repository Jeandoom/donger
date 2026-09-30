// ssh2 适配器：SshCommandRunner 端口的唯一生产实现。
// 每命令一连接（L1 简化：频率低、状态零残留；L2 landside 后此通道退救援用）。

import { Client } from "ssh2";
import type { SshCommandResult, SshCommandRunner } from "../ports/ssh-command-runner.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;

export const createSsh2CommandRunner = (): SshCommandRunner => {
  return (endpoint, auth, command, opts): Promise<SshCommandResult> =>
    new Promise((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputChars = opts?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      const conn = new Client();
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        conn.end();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(`SSH 命令超时（${timeoutMs}ms）：${endpoint.host} ${command.slice(0, 80)}`),
            ),
          ),
        timeoutMs,
      );

      conn
        .on("ready", () => {
          conn.exec(command, (execErr, stream) => {
            if (execErr) {
              finish(() => reject(new Error(`SSH exec 失败：${execErr.message}`)));
              return;
            }
            stream
              .on("close", (exitCode: number | null) => {
                finish(() => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
              })
              .on("data", (chunk: Buffer) => {
                if (stdout.length < maxOutputChars) stdout += chunk.toString("utf8");
              })
              .stderr.on("data", (chunk: Buffer) => {
                if (stderr.length < maxOutputChars) stderr += chunk.toString("utf8");
              });
          });
        })
        .on("error", (e: Error) => finish(() => reject(new Error(`SSH 连接失败：${e.message}`))))
        .connect({
          host: endpoint.host,
          port: endpoint.port,
          username: endpoint.username,
          ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
          ...(auth.password ? { password: auth.password } : {}),
          readyTimeout: Math.min(timeoutMs, 30_000),
        });
    });
};
