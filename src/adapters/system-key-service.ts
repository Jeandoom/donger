import { createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { createSecretCipher, type SecretCipher } from "../util/secret-cipher.js";
import { type ReEncryptReport, SecretReEncryptService } from "./secret-re-encrypt.js";

/** 密钥来源：首启自动生成 / 环境变量首次导入（过渡能力，待删）/ 轮换 / 手动导入历史 / 升级补录 */
export type SystemKeySource = "generated" | "env_imported" | "rotated" | "imported" | "upgraded";

export interface SystemKeyHistoryEntry {
  fingerprint: string;
  source: SystemKeySource;
  note?: string;
  createdAt: string;
  /** null = 当前生效密钥（head）；时间戳 = 何时被轮换退役 */
  retiredAt: string | null;
}

export interface SystemKeyStatus {
  /** sha256(seed) 前 12 位指纹；seed 明文永不回显 */
  fingerprint: string;
  source: SystemKeySource;
  createdAt: string;
  history: SystemKeyHistoryEntry[];
  /** 启动时仍检测到 SECRET_KEY/JWT_SECRET env（DB 优先语义下仅提示，不生效） */
  envKeyPresent: boolean;
  envKeyMatches: boolean;
}

export interface RotateResult {
  report: ReEncryptReport;
  /** 轮换提交后复扫：捕获轮换窗口内在途写入的旧钥残留 */
  leftover: ReEncryptReport;
  fingerprint: string;
}

const SEED_FLAG = "secret_key_seed";

/**
 * 系统密钥管理（授权页·密钥管理数据面）：
 * - 单一真源 = DB（app_config.secret_key_seed + secret_key_history.head），启动由 resolveSystemKeySeed 落定
 * - 轮换：数据重加密与密钥记录换头同一事务 → 提交后内存换钥 → 复扫残留；
 *   竞态窗口的在途解密靠 live cipher 的历史回退链兜底
 * - 导入历史密钥 / 深度修复：来源种子试解 → 当前种子重加密（外部漂移数据的恢复通道）
 */
export class SystemKeyService {
  private rotating = false;
  private readonly reEncrypt: SecretReEncryptService;

  constructor(
    private readonly db: Database,
    private readonly liveCipher: SecretCipher,
    /** 凭证集统一前旧格式兜底（skill-crypto keyHex），透传给重加密引擎 */
    private readonly legacySkillKeyHex: string,
    /** 启动时 env 候选值（仅用于 status 提示 envKeyPresent/Matches） */
    private readonly envSeed: string,
  ) {
    this.reEncrypt = new SecretReEncryptService(db);
  }

  isConfigured(): boolean {
    return this.currentSeed() !== "";
  }

  currentSeed(): string {
    const row = this.db.prepare("SELECT value FROM app_config WHERE key = ?").get(SEED_FLAG) as
      | { value: string }
      | undefined;
    return row?.value ?? "";
  }

  status(): SystemKeyStatus {
    const head = this.queryHead();
    return {
      fingerprint: fingerprintOf(this.currentSeed()),
      source: head?.source ?? "upgraded",
      createdAt: head?.createdAt ?? "",
      history: this.listHistory(),
      envKeyPresent: this.envSeed !== "",
      envKeyMatches: this.envSeed !== "" && this.envSeed === this.currentSeed(),
    };
  }

  listHistory(): SystemKeyHistoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT seed, source, note, createdAt, retiredAt FROM secret_key_history ORDER BY createdAt DESC",
      )
      .all() as Array<{
      seed: string;
      source: SystemKeySource;
      note: string | null;
      createdAt: string;
      retiredAt: string | null;
    }>;
    return rows.map((r) => ({
      fingerprint: fingerprintOf(r.seed),
      source: r.source,
      note: r.note ?? undefined,
      createdAt: r.createdAt,
      retiredAt: r.retiredAt,
    }));
  }

  /** 轮换：newSeed 由调用方给足熵（端点一键生成为 32 字节 hex；自定义值原样采纳） */
  rotate(input: { newSeed: string; note?: string }): RotateResult {
    const newSeed = input.newSeed.trim();
    if (!newSeed) throw new Error("新密钥不能为空");
    const oldSeed = this.currentSeed();
    if (!oldSeed) throw new Error("系统密钥未初始化，无法轮换");
    if (newSeed === oldSeed) throw new Error("新密钥与当前密钥相同");
    if (this.rotating) throw new Error("已有一次密钥轮换在进行中，请稍后");
    this.rotating = true;
    try {
      // 1) 数据重加密 + 密钥记录换头：同一事务（引擎内部事务嵌套为 savepoint）
      const swap = this.db.transaction(() => {
        const report = this.reEncrypt.run({
          targetSeed: newSeed,
          sourceSeeds: [oldSeed],
          legacySkillKeyHex: this.legacySkillKeyHex,
        });
        const now = new Date().toISOString();
        this.db
          .prepare("UPDATE secret_key_history SET retiredAt = ? WHERE retiredAt IS NULL")
          .run(now);
        this.insertKeyRow({
          seed: newSeed,
          source: "rotated",
          note: input.note,
          createdAt: now,
          retiredAt: null,
        });
        this.setSeedFlag(newSeed);
        return report;
      });
      const report = swap();
      // 2) 提交后内存换钥 + 刷新历史回退链（竞态窗口的在途解密由此兜底）
      this.applyLiveKey(newSeed);
      // 3) 复扫：轮换窗口内在途写入的旧钥残留
      const leftover = this.reEncrypt.run({
        targetSeed: newSeed,
        sourceSeeds: [oldSeed],
        legacySkillKeyHex: this.legacySkillKeyHex,
      });
      return { report, leftover, fingerprint: fingerprintOf(newSeed) };
    } finally {
      this.rotating = false;
    }
  }

  /** 导入历史密钥（外部漂移数据的恢复通道）：入库即退役，随即以它为来源跑一轮修复 */
  importHistory(input: { seed: string; note?: string }): ReEncryptReport {
    const seed = input.seed.trim();
    if (!seed) throw new Error("历史密钥不能为空");
    const current = this.currentSeed();
    if (!current) throw new Error("系统密钥未初始化");
    if (seed === current) throw new Error("不能导入当前生效密钥");
    const existing = this.db
      .prepare("SELECT id FROM secret_key_history WHERE seed = ?")
      .get(seed) as { id: number } | undefined;
    if (existing) throw new Error("该密钥已在历史记录中");
    const now = new Date().toISOString();
    this.insertKeyRow({
      seed,
      source: "imported",
      note: input.note,
      createdAt: now,
      retiredAt: now,
    });
    this.applyLiveKey(current);
    return this.reEncrypt.run({
      targetSeed: current,
      sourceSeeds: [seed],
      legacySkillKeyHex: this.legacySkillKeyHex,
    });
  }

  /** 深度修复：以全部历史密钥为来源，把仍解不开的密文收编到当前密钥（幂等） */
  repair(): ReEncryptReport {
    const current = this.currentSeed();
    if (!current) throw new Error("系统密钥未初始化");
    return this.reEncrypt.run({
      targetSeed: current,
      sourceSeeds: this.historySeeds(),
      legacySkillKeyHex: this.legacySkillKeyHex,
    });
  }

  /** live cipher 回退链用：全部退役种子的 cipher */
  historyCiphers(): SecretCipher[] {
    return this.historySeeds().map(createSecretCipher);
  }

  private historySeeds(): string[] {
    const rows = this.db
      .prepare("SELECT seed FROM secret_key_history WHERE retiredAt IS NOT NULL AND seed != ?")
      .all(this.currentSeed()) as Array<{ seed: string }>;
    return rows.map((r) => r.seed);
  }

  private applyLiveKey(seed: string): void {
    this.liveCipher.setMasterKey(createSecretCipher(seed).accessKey());
    this.liveCipher.setFallbacks(this.historyCiphers());
  }

  private queryHead(): { seed: string; source: SystemKeySource; createdAt: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT seed, source, createdAt FROM secret_key_history WHERE retiredAt IS NULL ORDER BY createdAt DESC LIMIT 1",
      )
      .get() as { seed: string; source: SystemKeySource; createdAt: string } | undefined;
    return row;
  }

  private insertKeyRow(e: {
    seed: string;
    source: SystemKeySource;
    note?: string;
    createdAt: string;
    retiredAt: string | null;
  }): void {
    this.db
      .prepare(
        "INSERT INTO secret_key_history (seed, source, note, createdAt, retiredAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(e.seed, e.source, e.note ?? null, e.createdAt, e.retiredAt);
  }

  private setSeedFlag(seed: string): void {
    this.db.prepare("UPDATE app_config SET value = ? WHERE key = ?").run(seed, SEED_FLAG);
  }
}

/**
 * 启动期密钥落定（系统密钥单一真源=DB）：
 * DB flag 存在 → 直接使用（head 缺失/不一致时补录历史行，兼容历史表上线前的存量库）；
 * DB 空 → env 候选首次导入入库（过渡能力，决策①后续删除）；
 * 双空 → 自动生成随机密钥并持久化（兜底，决策①保留）。
 * 返回 envIgnored=true 表示 env 有值但 DB 已有不同密钥（DB 优先，env 被忽略）。
 */
export function resolveSystemKeySeed(
  db: Database,
  envSeed: string,
): { seed: string; source: SystemKeySource; envIgnored: boolean } {
  migrateSecretKeyHistory(db);
  const now = new Date().toISOString();
  const flagRow = db.prepare("SELECT value FROM app_config WHERE key = ?").get(SEED_FLAG) as
    | { value: string }
    | undefined;
  if (flagRow?.value) {
    const seed = flagRow.value;
    const head = db
      .prepare(
        "SELECT seed, source FROM secret_key_history WHERE retiredAt IS NULL ORDER BY createdAt DESC LIMIT 1",
      )
      .get() as { seed: string; source: SystemKeySource } | undefined;
    if (!head || head.seed !== seed) {
      db.prepare(
        "INSERT INTO secret_key_history (seed, source, note, createdAt, retiredAt) VALUES (?, ?, ?, ?, ?)",
      ).run(seed, "upgraded", "升级补录：历史表上线前已存在的持久化密钥", now, null);
      return { seed, source: "upgraded", envIgnored: envSeed !== "" && envSeed !== seed };
    }
    return { seed, source: head.source, envIgnored: envSeed !== "" && envSeed !== seed };
  }
  if (envSeed) {
    db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(
      SEED_FLAG,
      envSeed,
    );
    db.prepare(
      "INSERT INTO secret_key_history (seed, source, note, createdAt, retiredAt) VALUES (?, ?, ?, ?, ?)",
    ).run(envSeed, "env_imported", "首次启动从环境变量导入（过渡能力）", now, null);
    return { seed: envSeed, source: "env_imported", envIgnored: false };
  }
  const generated = randomBytes(32).toString("hex");
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(
    SEED_FLAG,
    generated,
  );
  db.prepare(
    "INSERT INTO secret_key_history (seed, source, note, createdAt, retiredAt) VALUES (?, ?, ?, ?, ?)",
  ).run(generated, "generated", "首次启动自动生成", now, null);
  return { seed: generated, source: "generated", envIgnored: false };
}

/** 密钥历史表（幂等建表；供启动落定与服务共用） */
export function migrateSecretKeyHistory(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secret_key_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seed TEXT NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      createdAt TEXT NOT NULL,
      retiredAt TEXT
    )
  `);
}

/** sha256(seed) 前 12 位指纹；状态/历史面只出指纹，不出明文 */
export function fingerprintOf(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 12);
}
