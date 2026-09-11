import { describe, expect, it } from "vitest";
import { collectCredentialRefs } from "../../src/domain/connector.js";
import {
  mergeConnectorMcpServers,
  substituteCredentialRefs,
} from "../../src/domain/connector-resolution.js";

describe("substituteCredentialRefs", () => {
  const values = new Map<string, Record<string, string>>([
    ["single", { token: "v-single" }],
    ["multi", { a: "v-a", b: "v-b" }],
  ]);

  it("字面量直通：不含引用的值原样返回", () => {
    const r = substituteCredentialRefs({ "X-Tenant": "acme" }, values);
    expect(r).toEqual({ resolved: { "X-Tenant": "acme" }, missing: [] });
  });

  it("单键模板缺省 KEY：{{credential:code}} 取该键值", () => {
    const r = substituteCredentialRefs({ Authorization: "Bearer {{credential:single}}" }, values);
    expect(r.resolved.Authorization).toBe("Bearer v-single");
    expect(r.missing).toEqual([]);
  });

  it("显式 KEY：{{credential:code.KEY}} 直取指定键", () => {
    const r = substituteCredentialRefs({ "X-Key": "{{credential:multi.a}}" }, values);
    expect(r.resolved["X-Key"]).toBe("v-a");
    expect(r.missing).toEqual([]);
  });

  it("多键模板不带 KEY：歧义记入 missing 并替换为空串", () => {
    const r = substituteCredentialRefs({ Authorization: "Bearer {{credential:multi}}" }, values);
    expect(r.resolved.Authorization).toBe("Bearer ");
    expect(r.missing).toEqual(["multi"]);
  });

  it("模板缺失 / 显式键不存在：记入 missing 不抛错", () => {
    const r = substituteCredentialRefs(
      {
        A: "{{credential:nope}}",
        B: "{{credential:single.nokey}}",
      },
      values,
    );
    expect(r.resolved.A).toBe("");
    expect(r.resolved.B).toBe("");
    expect(r.missing).toEqual(["nope", "single.nokey"]);
  });

  it("同值多引用：全部替换，missing 去重排序", () => {
    const r = substituteCredentialRefs(
      { A: "{{credential:x1}}", B: "{{credential:x2}}", C: "{{credential:x1}}" },
      new Map(),
    );
    expect(r.missing).toEqual(["x1", "x2"]);
  });
});

describe("collectCredentialRefs", () => {
  it("提取全部引用 code 并去重", () => {
    const refs = collectCredentialRefs({
      Authorization: "Bearer {{credential:pat}}",
      "X-Api": "{{credential:pat.extra}}",
      Plain: "no-ref",
    });
    expect(refs).toEqual(["pat"]);
  });
});

describe("mergeConnectorMcpServers", () => {
  const inline = [
    { name: "amap", type: "http" as const, url: "https://inline/mcp" },
    { name: "kb", type: "http" as const, url: "https://kb/mcp" },
  ];
  const connectors = [{ name: "amap", type: "http" as const, url: "https://connector/mcp" }];

  it("连接器优先：同名内联配置被丢弃，其余保留", () => {
    const merged = mergeConnectorMcpServers(inline, connectors);
    expect(merged.map((s) => s.name)).toEqual(["amap", "kb"]);
    expect(merged.find((s) => s.name === "amap")?.url).toBe("https://connector/mcp");
  });

  it("无连接器时原样返回内联", () => {
    expect(mergeConnectorMcpServers(inline, [])).toEqual(inline);
  });
});
