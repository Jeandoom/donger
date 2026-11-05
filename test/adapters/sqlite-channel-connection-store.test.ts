import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteChannelConnectionStore } from "../../src/adapters/sqlite-channel-connection-store.js";

describe("SqliteChannelConnectionStore（渠道自持配置，拍板 D6）", () => {
  let store: SqliteChannelConnectionStore;
  beforeEach(() => {
    store = new SqliteChannelConnectionStore(new Database(":memory:"));
    store.migrate();
  });

  it("put/get：覆盖式更新 + enabled 元数据", () => {
    store.put("lark", "enc-v1", true);
    expect(store.get("lark")).toMatchObject({ platform: "lark", config: "enc-v1", enabled: 1 });
    store.put("lark", "enc-v2", false);
    const row = store.get("lark");
    expect(row?.config).toBe("enc-v2");
    expect(row?.enabled).toBe(0);
    store.setEnabled("lark", true);
    expect(store.get("lark")?.enabled).toBe(1);
  });

  it("list：多渠道隔离", () => {
    store.put("lark", "a", true);
    store.put("future-platform", "b", false);
    expect(store.list().map((r) => r.platform).sort()).toEqual(["future-platform", "lark"]);
  });
});
