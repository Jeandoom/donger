import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAppStore } from "../../src/adapters/sqlite-app-store.js";
import { type AppToolsDeps, appToolDefinitions } from "../../src/orchestrator/app-tools.js";

const roots: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.close();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "donger-app-tools-"));
  roots.push(dir);
  return dir;
}

function fixture(): { deps: AppToolsDeps; appsDir: string; runtimeDir: string } {
  const db = new Database(":memory:");
  dbs.push(db);
  const appStore = new SqliteAppStore(db);
  appStore.migrate();
  const appsDir = tmp();
  const runtimeDir = tmp();
  return {
    deps: { appStore, appsDir, runtimeDir, userId: "u1" },
    appsDir,
    runtimeDir,
  };
}

function site(dir: string, title: string): string {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<html><body><h1>${title}</h1></body></html>`);
  writeFileSync(join(dir, "assets", "app.js"), `console.log("${title}")`);
  return dir;
}

function tool(deps: AppToolsDeps, name: string) {
  const t = appToolDefinitions(deps).find((d) => d.name === name);
  if (!t) throw new Error(`tool 不存在: ${name}`);
  return t;
}

describe("donger-apps 工具（M2 开发链路）", () => {
  it("app_deploy 无 appId：创建应用并发布，产物落版本目录", async () => {
    const { deps, appsDir, runtimeDir } = fixture();
    const dir = site(join(runtimeDir, "dist"), "监控台");
    const r = await tool(deps, "app_deploy").handler({
      dir: "dist",
      name: "监控台",
      description: "测试",
    });
    expect(r.isError).toBeFalsy();
    const text = r.content[0]?.text ?? "";
    const appId = /appId=(app_[\w-]+)/.exec(text)?.[1];
    expect(appId).toBeTruthy();
    expect(text).toContain("/apps/");
    expect(text).toContain("v1");
    expect(readFileSync(join(appsDir, appId!, "versions", "1", "index.html"), "utf8")).toContain(
      "监控台",
    );
    expect(
      readFileSync(join(appsDir, appId!, "versions", "1", "assets", "app.js"), "utf8"),
    ).toContain("监控台");
    const app = await deps.appStore.get(appId!);
    expect(app?.currentVersion).toBe(1);
    expect(app?.userId).toBe("u1");
  });

  it("同 appId 重复部署产生新版本；app_publish 可回滚", async () => {
    const { deps, appsDir, runtimeDir } = fixture();
    const dir = site(join(runtimeDir, "dist"), "v1");
    const r1 = await tool(deps, "app_deploy").handler({ dir: "dist", name: "应用A" });
    writeFileSync(join(dir, "index.html"), "<html><body>v2</body></html>");
    const appId = /appId=(app_[\w-]+)/.exec(r1.content[0]?.text ?? "")?.[1] ?? "";
    const r2 = await tool(deps, "app_deploy").handler({ dir: "dist", appId });
    expect(r2.content[0]?.text).toContain("v2");
    expect(readFileSync(join(appsDir, appId, "versions", "2", "index.html"), "utf8")).toContain(
      "v2",
    );
    // v1 目录未被 v2 覆盖（版本不可变）
    expect(readFileSync(join(appsDir, appId, "versions", "1", "index.html"), "utf8")).toContain(
      "v1",
    );

    const back = await tool(deps, "app_publish").handler({ appId, num: 1 });
    expect(back.content[0]?.text).toContain("v1");
    expect((await deps.appStore.get(appId))?.currentVersion).toBe(1);
  });

  it("产物目录越界与缺 index.html 均拒绝", async () => {
    const { deps, runtimeDir } = fixture();
    const outside = tmp();
    site(outside, "外部站点");
    const r1 = await tool(deps, "app_deploy").handler({
      dir: "../" + outside.split(/[\\/]/).pop(),
      name: "x",
    });
    expect(r1.isError).toBeTruthy();
    mkdirSync(join(runtimeDir, "noentry"), { recursive: true });
    writeFileSync(join(runtimeDir, "noentry", "app.js"), "console.log(1)");
    const r2 = await tool(deps, "app_deploy").handler({ dir: "noentry", name: "x" });
    expect(r2.isError).toBeTruthy();
    expect(r2.content[0]?.text).toContain("index.html");
    void existsSync;
  });

  it("跨用户操作被拒（所有权闭包绑定）", async () => {
    const { deps, runtimeDir } = fixture();
    site(join(runtimeDir, "dist"), "x");
    const created = await tool(deps, "app_deploy").handler({ dir: "dist", name: "我的应用" });
    const appId = /appId=(app_[\w-]+)/.exec(created.content[0]?.text ?? "")?.[1] ?? "";
    const other: AppToolsDeps = { ...deps, userId: "u2" };
    const r = await tool(other, "app_deploy").handler({ dir: "dist", appId });
    expect(r.isError).toBeTruthy();
    expect(r.content[0]?.text).toContain("不属于当前用户");
  });

  it("app_list / app_versions / app_data_list / app_data_get 调试面", async () => {
    const { deps, runtimeDir } = fixture();
    site(join(runtimeDir, "dist"), "x");
    const created = await tool(deps, "app_deploy").handler({ dir: "dist", name: "应用B" });
    const appId = /appId=(app_[\w-]+)/.exec(created.content[0]?.text ?? "")?.[1] ?? "";
    expect((await tool(deps, "app_list").handler({})).content[0]?.text).toContain("应用B");
    expect((await tool(deps, "app_versions").handler({ appId })).content[0]?.text).toContain(
      "v1（当前）",
    );

    await deps.appStore.putData({
      appId,
      key: "prefs",
      valueJson: '{"theme":"dark"}',
      sizeBytes: 16,
      updatedAt: new Date().toISOString(),
    });
    const list = (await tool(deps, "app_data_list").handler({ appId })).content[0]?.text ?? "";
    expect(list).toContain("prefs");
    expect(
      (await tool(deps, "app_data_get").handler({ appId, key: "prefs" })).content[0]?.text,
    ).toBe('{"theme":"dark"}');
  });
});
