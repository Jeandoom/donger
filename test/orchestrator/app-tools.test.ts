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
    deps: { appStore, appsDir, runtimeDir, userId: "u1", importRoots: [runtimeDir] },
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
    const _dir = site(join(runtimeDir, "dist"), "监控台");
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
      dir: `../${outside.split(/[\\/]/).pop()}`,
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

  it("app_export → app_import 备份还原闭环（bundle+名称+运行数据）", async () => {
    const { deps, runtimeDir } = fixture();
    site(join(runtimeDir, "dist"), "备份目标");
    const created = await tool(deps, "app_deploy").handler({ dir: "dist", name: "备份目标" });
    const appId = /appId=(app_[\w-]+)/.exec(created.content[0]?.text ?? "")?.[1] ?? "";
    await deps.appStore.putData({
      appId,
      key: "prefs",
      valueJson: '{"threshold":5}',
      sizeBytes: 16,
      updatedAt: new Date().toISOString(),
    });

    const exp = await tool(deps, "app_export").handler({ appId });
    const expText = exp.content[0]?.text ?? "";
    expect(expText).toContain("app-backups");
    const zipPath = /备份完成：(.+\.zip)/.exec(expText)?.[1] ?? "";
    expect(existsSync(zipPath)).toBe(true);

    // 备份结构自检：meta kind + bundle 入口 + 数据
    const stage = join(runtimeDir, ".tmp", "verify");
    const { extractZipToDir } = await import("../../src/util/zip.js");
    extractZipToDir(readFileSync(zipPath), stage);
    const meta = JSON.parse(readFileSync(join(stage, "donger-app-backup.json"), "utf8")) as {
      kind: string;
      app: { name: string };
    };
    expect(meta.kind).toBe("donger-app-backup");
    expect(meta.app.name).toBe("备份目标");
    expect(existsSync(join(stage, "bundle", "index.html"))).toBe(true);
    rmSync(stage, { recursive: true, force: true });

    // 还原：相对路径引用工作区内 zip → 新应用 + 数据还原
    const relZip = zipPath.replace(runtimeDir, "").replace(/^[\\/]/, "");
    const imp = await tool(deps, "app_import").handler({ path: relZip });
    const impText = imp.content[0]?.text ?? "";
    expect(imp.isError).toBeFalsy();
    const newId = /appId=(app_[\w-]+)/.exec(impText)?.[1] ?? "";
    expect(newId).not.toBe(appId);
    const restored = await deps.appStore.get(newId);
    expect(restored?.name).toBe("备份目标");
    expect(restored?.currentVersion).toBe(1);
    expect((await deps.appStore.getData(newId, "prefs"))?.valueJson).toBe('{"threshold":5}');

    // 名称覆盖参数
    const imp2 = await tool(deps, "app_import").handler({ path: relZip, name: "还原改名" });
    const newId2 = /appId=(app_[\w-]+)/.exec(imp2.content[0]?.text ?? "")?.[1] ?? "";
    expect((await deps.appStore.get(newId2))?.name).toBe("还原改名");
  });

  it("app_import 拒绝非本平台备份与越界路径", async () => {
    const { deps, runtimeDir } = fixture();
    // 非 app_export 产出的普通 zip（无 donger-app-backup.json）
    const { zipDirToBuffer } = await import("../../src/util/zip.js");
    const plain = join(runtimeDir, "plain-src");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "index.html"), "<html>x</html>");
    const zipBuf = zipDirToBuffer(plain);
    const plainZip = join(runtimeDir, "plain.zip");
    writeFileSync(plainZip, zipBuf);
    const r1 = await tool(deps, "app_import").handler({ path: "plain.zip" });
    expect(r1.isError).toBeTruthy();
    expect(r1.content[0]?.text).toContain("不是本平台导出的应用备份");

    // 越界路径（不在 importRoots 内）
    const outside = tmp();
    const outsideZip = join(outside, "backup.zip");
    writeFileSync(outsideZip, zipBuf);
    const r2 = await tool(deps, "app_import").handler({ path: outsideZip });
    expect(r2.isError).toBeTruthy();
    expect(r2.content[0]?.text).toContain("越界");
  });

  it("应用管家制：app_create/app_deploy 新建自动落责任绑定（agentId 闭包）；plain 会话不落", async () => {
    const { deps, runtimeDir } = fixture();
    site(join(runtimeDir, "dist"), "x");
    const steward: AppToolsDeps = { ...deps, agentId: "agent-maycur" };
    const created = await tool(steward, "app_create").handler({ name: "maycur应用" });
    const appId = /appId=(app_[\w-]+)/.exec(created.content[0]?.text ?? "")?.[1] ?? "";
    expect((await deps.appStore.get(appId))?.managerAgentId).toBe("agent-maycur");

    const dep = await tool(steward, "app_deploy").handler({ dir: "dist", name: "新建应用" });
    const newId = /appId=(app_[\w-]+)/.exec(dep.content[0]?.text ?? "")?.[1] ?? "";
    expect((await deps.appStore.get(newId))?.managerAgentId).toBe("agent-maycur");

    const plain = await tool(deps, "app_create").handler({ name: "无主应用" });
    const plainId = /appId=(app_[\w-]+)/.exec(plain.content[0]?.text ?? "")?.[1] ?? "";
    expect((await deps.appStore.get(plainId))?.managerAgentId).toBeUndefined();
  });

  it("应用管家制：发布/回滚发射事件并通知 owner（fire-and-forget）", async () => {
    const { deps, runtimeDir } = fixture();
    site(join(runtimeDir, "dist"), "x");
    const events: Array<{ name: string; payload: string }> = [];
    const notified: string[] = [];
    const steward: AppToolsDeps = {
      ...deps,
      agentId: "agent-maycur",
      emitEvent: (name, payload) => {
        events.push({ name, payload });
      },
      notifications: {
        async notify(intent) {
          notified.push(`${intent.event}:${intent.title}`);
        },
      },
    };
    const dep = await tool(steward, "app_deploy").handler({ dir: "dist", name: "事件应用" });
    const appId = /appId=(app_[\w-]+)/.exec(dep.content[0]?.text ?? "")?.[1] ?? "";
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("app.published");
    const fact = JSON.parse(events[0]?.payload ?? "{}") as {
      app: { version: number; previousVersion: number | null; managerAgentId: string | null };
    };
    expect(fact.app).toMatchObject({
      version: 1,
      previousVersion: null,
      managerAgentId: "agent-maycur",
    });
    expect(notified).toEqual(["app.published:应用「事件应用」已发布 v1"]);

    await tool(steward, "app_deploy").handler({ dir: "dist", appId });
    events.length = 0;
    notified.length = 0;
    const back = await tool(steward, "app_publish").handler({ appId, num: 1 });
    expect(back.isError).toBeFalsy();
    expect(events.map((e) => e.name)).toEqual(["app.rolled_back"]);
    const fact2 = JSON.parse(events[0]?.payload ?? "{}") as { app: { from: number; to: number } };
    expect(fact2.app).toMatchObject({ from: 2, to: 1 });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.startsWith("app.rolled_back:")).toBe(true);
  });

  it("app_logs_tail：默认 error 过滤，level=all 看全部；跨用户拒绝", async () => {
    const { deps, runtimeDir } = fixture();
    site(join(runtimeDir, "dist"), "x");
    const created = await tool(deps, "app_deploy").handler({ dir: "dist", name: "日志应用" });
    const appId = /appId=(app_[\w-]+)/.exec(created.content[0]?.text ?? "")?.[1] ?? "";
    await deps.appStore.appendLogs(appId, [
      { source: "frontend", level: "error", message: "boom", ts: "t1" },
      {
        source: "gateway",
        level: "info",
        method: "GET",
        path: "/api/app-data/x",
        status: 200,
        ts: "t2",
      },
    ]);
    const errs = (await tool(deps, "app_logs_tail").handler({ appId })).content[0]?.text ?? "";
    expect(errs).toContain("boom");
    expect(errs).not.toContain("/api/app-data/x");
    const all = (
      await tool(deps, "app_logs_tail").handler({ appId, level: "all" })
    ).content[0]?.text;
    expect(all).toContain("/api/app-data/x");
    const other: AppToolsDeps = { ...deps, userId: "u2" };
    expect((await tool(other, "app_logs_tail").handler({ appId })).isError).toBeTruthy();
  });
});
