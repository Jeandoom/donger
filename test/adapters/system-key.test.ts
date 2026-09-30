import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretReEncryptService } from "../../src/adapters/secret-re-encrypt.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConnectorStore } from "../../src/adapters/sqlite-connector-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteLlmProviderStore } from "../../src/adapters/sqlite-llm-provider-store.js";
import { SqliteNotificationStore } from "../../src/adapters/sqlite-notification-store.js";
import {
  fingerprintOf,
  resolveSystemKeySeed,
  SystemKeyService,
} from "../../src/adapters/system-key-service.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";
import { encryptValue } from "../../src/util/skill-crypto.js";

const OLD_SEED = "seed-old";
const NEW_SEED = "seed-new";
const LEGACY_SKILL_KEY_HEX = "a".repeat(64);

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
});

const agentInput = {
  ownerId: "u1",
  name: "A",
  skills: ["s:1"],
  tools: { mode: "whitelist" as const, whitelist: ["Bash"] },
  mcpServers: [
    {
      name: "m",
      type: "http" as const,
      url: "https://x",
      env: { TOKEN: "env-plain" },
      headers: { SECRET: "hdr-plain" },
    },
  ],
};

/** 布点六处密文：provider/connector/agent(含 v1 快照)/通知地址/凭证集（含旧 skill-crypto 格式一行） */
async function seedAllFamilies() {
  const old = createSecretCipher(OLD_SEED);
  const providers = new SqliteLlmProviderStore(db, old);
  providers.migrate();
  const agents = new SqliteAgentStore(db, old);
  agents.migrate();
  const connectors = new SqliteConnectorStore(db, old);
  connectors.migrate();
  const notifications = new SqliteNotificationStore(db, old);
  notifications.migrate();

  const p = await providers.create("u1", {
    name: "zhipu",
    platform: "zhipu",
    baseUrl: "https://open.bigmodel.cn",
    key: "zk-123",
    models: ["glm-4"],
    sdkType: "anthropic",
    isDefault: true,
  });
  const conn = await connectors.create(
    { name: "amap", url: "https://mcp.amap.com/mcp", headers: { Authorization: "Bearer k" } },
    "u1",
  );
  const agent = await agents.create(agentInput);
  await notifications.putAddress({
    userId: "u1",
    channel: "webhook",
    address: "https://hook.example",
    extra: { token: "tk-1" },
  });
  // 旧 skill-crypto 格式凭证（统一迁移的存量形态）：先建表再插，二次 migrate 走统一收编
  const csets = new SqliteCredentialSetStore(db, old, LEGACY_SKILL_KEY_HEX);
  csets.migrate();
  db.prepare(
    "INSERT INTO user_credential_values (userId, code, valuesCipher, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
  ).run(
    "u1",
    "legacy-cred",
    encryptValue(LEGACY_SKILL_KEY_HEX, JSON.stringify({ token: "legacy-tk" })),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  csets.migrate();
  expect((await csets.getFilledValues("u1", ["legacy-cred"]))[0]?.values).toEqual({
    token: "legacy-tk",
  });
  await csets.upsertValue("u1", "fresh-cred", { token: "fresh-tk" });
  return { providerId: p.id, conn, agent };
}

describe("resolveSystemKeySeed（启动密钥落定：DB 优先）", () => {
  it("双空 → 自动生成并持久化；再次启动 DB 优先且来源回读 head", () => {
    const first = resolveSystemKeySeed(db, "");
    expect(first.source).toBe("generated");
    expect(first.seed).toBeTruthy();
    const second = resolveSystemKeySeed(db, "");
    expect(second.seed).toBe(first.seed);
    expect(second.source).toBe("generated");
    expect(second.envIgnored).toBe(false);
  });

  it("DB 空 + env 有值 → env 首次导入入库（过渡能力）", () => {
    const boot = resolveSystemKeySeed(db, "env-secret");
    expect(boot.source).toBe("env_imported");
    expect(boot.seed).toBe("env-secret");
  });

  it("DB 有钥 + env 不同 → 用 DB 并报告 envIgnored；env 相同则不算冲突", () => {
    resolveSystemKeySeed(db, "env-secret");
    const withDifferentEnv = resolveSystemKeySeed(db, "another-env");
    expect(withDifferentEnv.seed).toBe("env-secret");
    expect(withDifferentEnv.envIgnored).toBe(true);
    const withSameEnv = resolveSystemKeySeed(db, "env-secret");
    expect(withSameEnv.envIgnored).toBe(false);
  });

  it("flag 存在但历史表缺失（升级库）→ 补录 head 行，来源 upgraded", () => {
    db.prepare(
      "INSERT INTO app_config (key, value) VALUES ('secret_key_seed', 'legacy-db-seed')",
    ).run();
    const boot = resolveSystemKeySeed(db, "");
    expect(boot.seed).toBe("legacy-db-seed");
    expect(boot.source).toBe("upgraded");
    const head = db
      .prepare("SELECT source FROM secret_key_history WHERE retiredAt IS NULL")
      .get() as { source: string };
    expect(head.source).toBe("upgraded");
  });
});

describe("SystemKeyService（轮换/导入/修复/回退链）", () => {
  it("轮换：六处密文全部重加密到新种子，历史换头，旧钥进回退链", async () => {
    await seedAllFamilies();
    resolveSystemKeySeed(db, OLD_SEED); // 启动落定：当前系统密钥 = OLD_SEED（模拟 env 导入）
    const liveCipher = createSecretCipher(OLD_SEED);
    const svc = new SystemKeyService(db, liveCipher, LEGACY_SKILL_KEY_HEX, "");
    expect(svc.isConfigured()).toBe(true);

    const result = svc.rotate({ newSeed: NEW_SEED });
    // provider1 + connector1 + agent env/headers2 + 版本快照2 + 通知1 + 凭证集2（含收编的旧格式行）
    expect(result.report.healed).toBe(9);
    expect(result.leftover.healed).toBe(0);
    expect(result.fingerprint).toBe(fingerprintOf(NEW_SEED));

    const status = svc.status();
    expect(status.fingerprint).toBe(fingerprintOf(NEW_SEED));
    expect(status.source).toBe("rotated");
    expect(status.history).toHaveLength(2);
    expect(
      status.history.find((h) => h.fingerprint === fingerprintOf(OLD_SEED))?.retiredAt,
    ).toBeTruthy();

    // 新种子全链路可读（含统一后的凭证集）
    const newProviders = new SqliteLlmProviderStore(db, createSecretCipher(NEW_SEED));
    const mine = await newProviders.list("u1");
    const zhipu = mine.find((p) => p.name === "zhipu");
    if (!zhipu) throw new Error("夹具缺失：zhipu");
    expect((await newProviders.getWithKey("u1", zhipu.id))?.key).toBe("zk-123");

    const newCsets = new SqliteCredentialSetStore(
      db,
      createSecretCipher(NEW_SEED),
      LEGACY_SKILL_KEY_HEX,
    );
    const legacyValues = (await newCsets.getFilledValues("u1", ["legacy-cred"]))[0];
    expect(legacyValues?.values).toEqual({ token: "legacy-tk" });
    expect((await newCsets.getFilledValues("u1", ["fresh-cred"]))[0]?.values).toEqual({
      token: "fresh-tk",
    });

    // 回退链：轮换后在途/残留旧钥密文仍可经 liveCipher 解开（stores 持有的同一实例已被换钥）
    db.prepare("UPDATE user_llm_providers SET key = ?").run(
      createSecretCipher(OLD_SEED).encrypt("late"),
    );
    expect(
      liveCipher.decrypt(
        (db.prepare("SELECT key FROM user_llm_providers LIMIT 1").get() as { key: string }).key,
      ),
    ).toBe("late");
    // 深度修复把残留收编到新钥
    const repaired = svc.repair();
    expect(repaired.healed).toBe(1);
  });

  it("轮换幂等约束：同种子/空种子/未初始化拒绝", async () => {
    const liveCipher = createSecretCipher(OLD_SEED);
    const svc = new SystemKeyService(db, liveCipher, LEGACY_SKILL_KEY_HEX, "");
    expect(() => svc.rotate({ newSeed: "" })).toThrow(/不能为空/);
    expect(() => svc.rotate({ newSeed: OLD_SEED })).toThrow(/系统密钥未初始化|相同/);
    resolveSystemKeySeed(db, OLD_SEED);
    expect(() => svc.rotate({ newSeed: OLD_SEED })).toThrow(/相同/);
    expect(() => svc.rotate({ newSeed: NEW_SEED })).not.toThrow();
  });

  it("导入历史密钥：外部种子密文被收编；重复导入拒绝", async () => {
    resolveSystemKeySeed(db, NEW_SEED);
    const liveCipher = createSecretCipher(NEW_SEED);
    const svc = new SystemKeyService(db, liveCipher, LEGACY_SKILL_KEY_HEX, "seed-external");
    const providers = new SqliteLlmProviderStore(db, createSecretCipher(NEW_SEED));
    providers.migrate();
    await providers.create("u1", {
      name: "fresh",
      platform: "zhipu",
      baseUrl: "https://open.bigmodel.cn",
      key: "new-key",
      models: ["glm-4"],
      sdkType: "anthropic",
      isDefault: true,
    });
    // 外部漂移密文（旧部署种子）
    db.prepare(
      "INSERT INTO user_llm_providers (id, userId, name, platform, baseUrl, key, models, sdkType, isDefault, createdAt, updatedAt) VALUES ('ext','u1','ext','zhipu','https://x',?, '[]','anthropic',0,'t','t')",
    ).run(createSecretCipher("seed-external").encrypt("ext-secret"));

    const report = svc.importHistory({ seed: "seed-external", note: "旧部署种子" });
    expect(report.healed).toBe(1);
    const row = db.prepare("SELECT key FROM user_llm_providers WHERE id = 'ext'").get() as {
      key: string;
    };
    expect(liveCipher.decryptStrict(row.key)).toBe("ext-secret");
    expect(liveCipher.decrypt(row.key)).toBe("ext-secret");

    expect(() => svc.importHistory({ seed: "seed-external" })).toThrow(/已在历史/);
    expect(() => svc.importHistory({ seed: NEW_SEED })).toThrow(/当前生效/);
    // 导入后进入回退链 + 历史时间线
    expect(
      svc.status().history.some((h) => h.source === "imported" && h.note === "旧部署种子"),
    ).toBe(true);
  });
});

describe("SecretCipher 回退链", () => {
  it("当前钥解不开时依次回退历史钥；decryptStrict 不走回退链", () => {
    const oldBlob = createSecretCipher(OLD_SEED).encrypt("x");
    const live = createSecretCipher(NEW_SEED);
    expect(() => live.decryptStrict(oldBlob)).toThrow();
    live.setFallbacks([createSecretCipher(OLD_SEED)]);
    expect(live.decrypt(oldBlob)).toBe("x");
    expect(() => live.decrypt("v1:bogus")).toThrow(/主密钥|密文长度异常/);
  });

  it("重加密引擎：统一前旧格式凭证行经 legacySkillKeyHex 兜底收编", async () => {
    const csets = new SqliteCredentialSetStore(
      db,
      createSecretCipher(OLD_SEED),
      LEGACY_SKILL_KEY_HEX,
    );
    csets.migrate();
    db.prepare(
      "INSERT INTO user_credential_values (userId, code, valuesCipher, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "u1",
      "oldfmt",
      encryptValue(LEGACY_SKILL_KEY_HEX, JSON.stringify({ token: "old-tk" })),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const report = new SecretReEncryptService(db).run({
      targetSeed: NEW_SEED,
      sourceSeeds: [OLD_SEED],
      legacySkillKeyHex: LEGACY_SKILL_KEY_HEX,
    });
    expect(report.healed).toBe(1);
    const row = db
      .prepare("SELECT valuesCipher FROM user_credential_values WHERE code = 'oldfmt'")
      .get() as { valuesCipher: string };
    expect(row.valuesCipher.startsWith("v1:")).toBe(true);
    expect(
      (
        await new SqliteCredentialSetStore(
          db,
          createSecretCipher(NEW_SEED),
          LEGACY_SKILL_KEY_HEX,
        ).getFilledValues("u1", ["oldfmt"])
      )[0]?.values,
    ).toEqual({ token: "old-tk" });
  });
});
