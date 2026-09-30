import type { Database } from "better-sqlite3";
import { createSecretCipher } from "../util/secret-cipher.js";
import { decryptValue } from "../util/skill-crypto.js";

/** 一条无法恢复的密文（当前种子与全部来源种子均解不开，需手动重新录入） */
export interface ReEncryptFailure {
  kind: string;
  name: string;
  field: string;
}

export interface ReEncryptReport {
  /** 检查的 v1: 密文总数 */
  scanned: number;
  /** 目标种子已可解开（含无需处理的非密文值） */
  healthy: number;
  /** 用来源种子解开并已用目标种子重加密写回 */
  healed: number;
  /** 无法恢复清单 */
  failed: ReEncryptFailure[];
  /** 参与回退的来源种子个数 */
  sourceSeeds: number;
}

export interface ReEncryptParams {
  /** 目标种子：全部密文向它重加密（轮换=新钥；体检/修复=当前钥） */
  targetSeed: string;
  /** 来源种子：目标解不开时依次试解（轮换=旧钥；修复=历史钥） */
  sourceSeeds: string[];
  /** 凭证集统一前旧格式（skill-crypto iv:tag:ct）的兜底 keyHex */
  legacySkillKeyHex?: string;
}

const BLOB_PREFIX = "v1:";

/** 行内一个待迁移密文：field 为展示用字段定位 */
interface BlobHit {
  field: string;
  blob: string;
}

/** 一行的迁移计划：定位全部密文，重加密后整体写回 */
interface RowPlan {
  kind: string;
  name: string;
  blobs: BlobHit[];
  write: (replaced: Map<string, string>) => void;
}

/**
 * 密钥重加密引擎：以目标种子为基准扫描全部落库密文，解不开的依次试来源种子，
 * 解开即以目标种子重加密写回（幂等，可反复执行；全部解不开的列入 failed 供手动重录）。
 *
 * 覆盖六处落库密文（SecretCipher 系五处 + 凭证集）：
 * - user_llm_providers.key（模型密钥）
 * - connectors.data 内 headers（连接器）
 * - agents.data / agent_versions.data 内 mcpServers[].env/headers（智能体含版本快照）
 * - notification_addresses.extra（通知地址）
 * - user_credential_values.valuesCipher（凭证集；统一前旧格式走 legacySkillKeyHex）
 *
 * 内部自建种子 cipher（不带回退链）——健康判定必须只看目标种子，live cipher 的回退链会污染判定。
 * 由 SystemKeyService 在轮换/导入/修复时调用；单次调用独立事务（可嵌套入外层事务作 savepoint）。
 */
export class SecretReEncryptService {
  constructor(private readonly db: Database) {}

  run(params: ReEncryptParams): ReEncryptReport {
    const target = createSecretCipher(params.targetSeed);
    const sources = [
      ...new Set(params.sourceSeeds.filter((s) => s && s !== params.targetSeed)),
    ].map(createSecretCipher);
    const report: ReEncryptReport = {
      scanned: 0,
      healthy: 0,
      healed: 0,
      failed: [],
      sourceSeeds: sources.length,
    };
    const tx = this.db.transaction(() => {
      for (const plan of this.collectPlans(report)) {
        const replaced = new Map<string, string>();
        for (const hit of plan.blobs) {
          report.scanned++;
          if (this.tryDecrypt(target, hit.blob)) {
            report.healthy++;
            continue;
          }
          const plain = this.decryptViaSources(sources, hit.blob, params.legacySkillKeyHex);
          if (plain === undefined) {
            report.failed.push({ kind: plan.kind, name: plan.name, field: hit.field });
            continue;
          }
          replaced.set(hit.field, target.encrypt(plain));
        }
        if (replaced.size > 0) {
          plan.write(replaced);
          report.healed += replaced.size;
        }
      }
    });
    tx();
    return report;
  }

  private tryDecrypt(cipher: ReturnType<typeof createSecretCipher>, blob: string): boolean {
    try {
      cipher.decryptStrict(blob);
      return true;
    } catch {
      return false;
    }
  }

  /** 来源种子（v1: 格式）→ 凭证集旧格式（skill-crypto）兜底 */
  private decryptViaSources(
    sources: Array<ReturnType<typeof createSecretCipher>>,
    blob: string,
    legacySkillKeyHex?: string,
  ): string | undefined {
    if (!blob.startsWith(BLOB_PREFIX) && legacySkillKeyHex) {
      try {
        return decryptValue(legacySkillKeyHex, blob);
      } catch {
        return undefined;
      }
    }
    for (const cipher of sources) {
      try {
        return cipher.decrypt(blob);
      } catch {
        // 下一把来源种子
      }
    }
    return undefined;
  }

  private collectPlans(report: ReEncryptReport): RowPlan[] {
    return [
      ...this.providerPlans(),
      ...this.connectorPlans(report),
      ...this.agentPlans(
        report,
        "智能体 MCP 密钥",
        "SELECT id, json_extract(data, '$.name') AS name, data FROM agents",
        (id, data) => this.db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(data, id),
      ),
      ...this.agentPlans(
        report,
        "智能体版本快照",
        "SELECT agentId || ':' || version AS id, agentId || '@v' || version AS name, data FROM agent_versions",
        (id, data) => {
          const [agentId, version] = id.split(":");
          this.db
            .prepare("UPDATE agent_versions SET data = ? WHERE agentId = ? AND version = ?")
            .run(data, agentId, Number(version));
        },
      ),
      ...this.notifyAddressPlans(),
      ...this.credentialValuePlans(),
    ];
  }

  /** 模型密钥：独立密文列，直改 key */
  private providerPlans(): RowPlan[] {
    const rows = this.rows<{ id: string; name: string; key: string }>(
      "SELECT id, name, key FROM user_llm_providers",
    );
    return rows.map((r) => ({
      kind: "模型密钥",
      name: r.name,
      blobs: [{ field: "key", blob: r.key }],
      write: (m) => {
        const ct = m.get("key");
        if (ct) {
          this.db.prepare("UPDATE user_llm_providers SET key = ? WHERE id = ?").run(ct, r.id);
        }
      },
    }));
  }

  /** 连接器：data JSON 内 headers 为密文 */
  private connectorPlans(report: ReEncryptReport): RowPlan[] {
    const rows = this.rows<{ id: string; name: string; data: string }>(
      "SELECT id, name, data FROM connectors",
    );
    return rows.map((r) => {
      const parsed = this.parseJson(report, "连接器", r.name, r.data, {});
      const headers = (parsed as { headers?: unknown }).headers;
      const hit =
        typeof headers === "string" && headers.startsWith(BLOB_PREFIX)
          ? { field: "headers", blob: headers }
          : null;
      return {
        kind: "连接器",
        name: r.name,
        blobs: hit ? [hit] : [],
        write: (m) => {
          const ct = m.get("headers");
          if (!ct) return;
          (parsed as { headers: string }).headers = ct;
          this.db
            .prepare("UPDATE connectors SET data = ? WHERE id = ?")
            .run(JSON.stringify(parsed), r.id);
        },
      };
    });
  }

  /** 智能体/版本快照：data JSON 内 mcpServers[].env/headers 为密文 */
  private agentPlans(
    report: ReEncryptReport,
    kind: string,
    sql: string,
    writeBack: (id: string, data: string) => void,
  ): RowPlan[] {
    const rows = this.rows<{ id: string; name: string | null; data: string }>(sql);
    return rows.map((r) => {
      const name = r.name ?? r.id;
      const parsed = this.parseJson<{ mcpServers?: Array<Record<string, unknown>> }>(
        report,
        kind,
        name,
        r.data,
        { mcpServers: [] },
      );
      const hits: BlobHit[] = [];
      const apply: Array<(ct: string) => void> = [];
      for (const [i, server] of (parsed.mcpServers ?? []).entries()) {
        for (const k of ["env", "headers"] as const) {
          const v = server?.[k];
          if (typeof v === "string" && v.startsWith(BLOB_PREFIX)) {
            hits.push({ field: `mcpServers[${i}].${k}`, blob: v });
            apply.push((ct) => {
              server[k] = ct;
            });
          }
        }
      }
      return {
        kind,
        name,
        blobs: hits,
        write: (m) => {
          for (const [idx, hit] of hits.entries()) {
            const ct = m.get(hit.field);
            if (ct) apply[idx]?.(ct);
          }
          writeBack(r.id, JSON.stringify(parsed));
        },
      };
    });
  }

  /** 通知地址：extra 可空密文列 */
  private notifyAddressPlans(): RowPlan[] {
    const rows = this.rows<{ userId: string; channel: string; address: string; extra: string }>(
      "SELECT userId, channel, address, extra FROM notification_addresses WHERE extra IS NOT NULL",
    );
    return rows.map((r) => ({
      kind: "通知地址",
      name: `${r.address}（${r.channel}）`,
      blobs: r.extra.startsWith(BLOB_PREFIX) ? [{ field: "extra", blob: r.extra }] : [],
      write: (m) => {
        const ct = m.get("extra");
        if (ct) {
          this.db
            .prepare("UPDATE notification_addresses SET extra = ? WHERE userId = ? AND channel = ?")
            .run(ct, r.userId, r.channel);
        }
      },
    }));
  }

  /** 凭证集：valuesCipher（统一后 v1: 格式；统一前旧格式经 legacySkillKeyHex 兜底） */
  private credentialValuePlans(): RowPlan[] {
    const rows = this.rows<{ userId: string; code: string; valuesCipher: string }>(
      "SELECT userId, code, valuesCipher FROM user_credential_values",
    );
    return rows.map((r) => ({
      kind: "凭证集",
      name: `${r.userId}/${r.code}`,
      blobs: [{ field: "valuesCipher", blob: r.valuesCipher }],
      write: (m) => {
        const ct = m.get("valuesCipher");
        if (ct) {
          this.db
            .prepare(
              "UPDATE user_credential_values SET valuesCipher = ? WHERE userId = ? AND code = ?",
            )
            .run(ct, r.userId, r.code);
        }
      },
    }));
  }

  /** data JSON 解析；损坏行记为 failed（密文状态未知，不盲写） */
  private parseJson<T>(
    report: ReEncryptReport,
    kind: string,
    name: string,
    data: string,
    fallback: T,
  ): T {
    try {
      return JSON.parse(data) as T;
    } catch {
      report.failed.push({ kind, name, field: "data(JSON 损坏)" });
      return fallback;
    }
  }

  private rows<T>(sql: string): T[] {
    try {
      return this.db.prepare(sql).all() as T[];
    } catch (e) {
      // 部分部署可能未装配对应 store（表不存在）：按空集处理，不阻断其余目标
      if (e instanceof Error && e.message.includes("no such table")) return [];
      throw e;
    }
  }
}
