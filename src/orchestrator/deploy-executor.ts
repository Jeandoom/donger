// 部署执行器：DeployOrder 状态机的唯一推进者（API 手动触发 / agent service_deploy /
// 轮询器自动触发共用）。互斥=内存锁 + 单 target 串行；SSH 逐条执行剧本命令。

import type { DeployOrder, DeployStep, DeployTarget } from "../domain/deploy.js";
import { renderDeployCommand } from "../domain/deploy.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { DeployStore } from "../ports/deploy-store.js";
import type {
  SshAuthMaterial,
  SshCommandOptions,
  SshCommandRunner,
} from "../ports/ssh-command-runner.js";
import type { Logger } from "../util/logger.js";
import type { NotificationService } from "./notification-service.js";

export interface DeployExecutorDeps {
  deployStore: DeployStore;
  credentialSets: CredentialSetStore;
  sshRunner: SshCommandRunner;
  notifications?: NotificationService;
  logger: Logger;
  /** 单命令超时（缺省 180s——构建类命令比诊断类长） */
  commandTimeoutMs?: number;
}

const STEP_OUTPUT_TAIL = 2000;

function tail(text: string, max = STEP_OUTPUT_TAIL): string {
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}

/** 解析目标机 SSH 凭证（按 target 属主，generic 模板键 private_key/password） */
export async function resolveSshAuth(
  credentialSets: CredentialSetStore,
  target: DeployTarget,
): Promise<SshAuthMaterial> {
  const [filled] = await credentialSets.getFilledValues(target.ownerId, [
    target.ssh.credentialCode,
  ]);
  const values = filled?.values ?? {};
  const auth: SshAuthMaterial = {};
  if (values.private_key) auth.privateKey = values.private_key;
  if (values.password) auth.password = values.password;
  if (!auth.privateKey && !auth.password) {
    throw new Error(
      `SSH 凭证未填写：目标 ${target.name} 引用模板 ${target.ssh.credentialCode}（需 private_key 或 password 至少其一）`,
    );
  }
  return auth;
}

export interface RunDeployInput {
  trigger: "poll" | "manual" | "agent";
  /** 部署指向（sha/tag/branch）；缺省用 target.branch */
  ref?: string;
}

export class DeployExecutor {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DeployExecutorDeps) {}

  /** 同 target 互斥：并发调用串行排队（后到者等前者完成后立即失败——避免陈旧 sha 覆盖新部署） */
  async run(target: DeployTarget, input: RunDeployInput): Promise<DeployOrder> {
    const prev = this.locks.get(target.id);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(
      target.id,
      (prev ?? Promise.resolve()).then(() => gate),
    );
    await prev;
    try {
      return await this.runLocked(target, input);
    } finally {
      release();
      if (this.locks.get(target.id) === gate) this.locks.delete(target.id);
    }
  }

  private async runLocked(target: DeployTarget, input: RunDeployInput): Promise<DeployOrder> {
    const now = new Date().toISOString();
    const order = await this.deps.deployStore.createOrder({
      id: crypto.randomUUID(),
      targetId: target.id,
      trigger: input.trigger,
      ref: input.ref ?? target.branch,
      status: "running",
      steps: [],
      startedAt: now,
    });
    const steps: DeployStep[] = [];
    const finish = async (patch: Partial<DeployOrder>) => {
      await this.deps.deployStore.updateOrder(order.id, { ...patch, steps });
    };
    try {
      const auth = await resolveSshAuth(this.deps.credentialSets, target);
      const sshOpts: SshCommandOptions = {
        timeoutMs: this.deps.commandTimeoutMs ?? 180_000,
      };
      const vars = {
        ref: order.ref,
        branch: target.branch,
        workdir: target.workdir,
        service: target.service,
      };
      // 1. 剧本逐条执行（任一非零退出即失败）
      for (let i = 0; i < target.prepareCommands.length; i++) {
        const command = renderDeployCommand(target.prepareCommands[i] ?? "", vars);
        const step = await this.execStep(target, auth, sshOpts, `prepare[${i + 1}]`, command);
        steps.push(step);
        await finish({ status: "running" });
        if (step.exitCode !== 0) {
          return await this.finishFailed(
            target,
            order,
            steps,
            `步骤 ${step.name} 退出码 ${step.exitCode}`,
          );
        }
      }
      // 2. 健康检查（可选）
      if (target.healthCheck) {
        const command = renderDeployCommand(target.healthCheck.cmd, vars);
        const step = await this.execStep(target, auth, sshOpts, "health", command);
        steps.push(step);
        const healthy =
          step.exitCode === 0 &&
          (!target.healthCheck.expectContains ||
            step.outputTail.includes(target.healthCheck.expectContains));
        if (!healthy) {
          return await this.finishFailed(
            target,
            order,
            steps,
            `健康检查未通过（exit=${step.exitCode}${target.healthCheck.expectContains ? `，输出未含 "${target.healthCheck.expectContains}"` : ""}）`,
          );
        }
      }
      const sha = input.ref && /^[0-9a-f]{7,40}$/i.test(input.ref) ? input.ref : undefined;
      await finish({
        status: "success",
        sha,
        finishedAt: new Date().toISOString(),
      });
      await this.notify(
        target,
        "deploy.succeeded",
        `部署成功：${target.name}`,
        `ref=${order.ref ?? "-"}${sha ? ` @${sha.slice(0, 8)}` : ""}`,
      );
      return { ...order, status: "success", steps, sha };
    } catch (e) {
      return await this.finishFailed(target, order, steps, (e as Error).message);
    }
  }

  private async execStep(
    target: DeployTarget,
    auth: SshAuthMaterial,
    sshOpts: SshCommandOptions,
    name: string,
    command: string,
  ): Promise<DeployStep> {
    const started = Date.now();
    try {
      const r = await this.deps.sshRunner(
        { host: target.ssh.host, port: target.ssh.port, username: target.ssh.username },
        auth,
        command,
        sshOpts,
      );
      return {
        name,
        command,
        exitCode: r.exitCode,
        durationMs: Date.now() - started,
        outputTail: tail([r.stdout, r.stderr].filter(Boolean).join("\n")),
      };
    } catch (e) {
      return {
        name,
        command,
        exitCode: -1,
        durationMs: Date.now() - started,
        outputTail: tail((e as Error).message),
      };
    }
  }

  private async finishFailed(
    target: DeployTarget,
    order: DeployOrder,
    steps: DeployStep[],
    error: string,
  ): Promise<DeployOrder> {
    const message = error.slice(0, 1000);
    await this.deps.deployStore.updateOrder(order.id, {
      status: "failed",
      error: message,
      steps,
      finishedAt: new Date().toISOString(),
    });
    this.deps.logger.warn({ targetId: target.id, orderId: order.id, error }, "deploy failed");
    await this.notify(target, "deploy.failed", `部署失败：${target.name}`, message);
    return { ...order, status: "failed", steps, error: message };
  }

  private async notify(
    target: DeployTarget,
    event: "deploy.succeeded" | "deploy.failed",
    title: string,
    body: string,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      await this.deps.notifications.notify({
        event,
        recipients: [{ kind: "user", userId: target.ownerId }],
        title,
        body,
        dedupeKey: `${event}:${target.id}:${crypto.randomUUID()}`,
      });
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message }, "deploy notify failed");
    }
  }

  /** service_restart 工具通道：重启剧本逐条执行（不建部署单，直接返回步骤结果） */
  async runRestart(target: DeployTarget): Promise<DeployStep[]> {
    if (!target.restartCommands.length) {
      throw new Error(`目标 ${target.name} 未配置 restartCommands，不支持重启动作`);
    }
    const auth = await resolveSshAuth(this.deps.credentialSets, target);
    const vars = {
      branch: target.branch,
      workdir: target.workdir,
      service: target.service,
    };
    const steps: DeployStep[] = [];
    for (let i = 0; i < target.restartCommands.length; i++) {
      const command = renderDeployCommand(target.restartCommands[i] ?? "", vars);
      const step = await this.execStep(
        target,
        auth,
        { timeoutMs: this.deps.commandTimeoutMs ?? 180_000 },
        `restart[${i + 1}]`,
        command,
      );
      steps.push(step);
      if (step.exitCode !== 0)
        throw new Error(`重启步骤 ${step.name} 退出码 ${step.exitCode}：${step.outputTail}`);
    }
    return steps;
  }
}
