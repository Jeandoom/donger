import { describe, expect, it } from "vitest";
import { APP_PROXY_MAX_BINDINGS, parseProxyBindings } from "../../src/domain/app.js";
import {
  AUTH_STYLE_REQUIRED_KEYS,
  type Connector,
  ConnectorAuthSchema,
  collectConnectorCredentialCodes,
} from "../../src/domain/connector.js";

/** 出网通道域规则（spec 2026-09-29-app-proxy-credential-binding §2）：服务名/上限/认证风格/凭证收集 */
describe("proxyBindings 域校验", () => {
  it("合法服务名与绑定通过", () => {
    const b = parseProxyBindings({ jihulab: "conn_a", jenkins: "conn_b", ops: "conn_c" });
    expect(b).toMatchObject({ jihulab: "conn_a" });
  });

  it("服务名：大写/数字开头/超长/非法字符拒绝；空串拒绝", () => {
    for (const bad of ["Jihulab", "1abc", "a".repeat(33), "has_underscore", "has.dot", ""]) {
      expect(() => parseProxyBindings({ [bad]: "conn_a" })).toThrow();
    }
  });

  it(`绑定数上限 ${APP_PROXY_MAX_BINDINGS} 条`, () => {
    const ok = Object.fromEntries(
      Array.from({ length: APP_PROXY_MAX_BINDINGS }, (_, i) => [`svc-${i}`, "conn_a"]),
    );
    expect(() => parseProxyBindings(ok)).not.toThrow();
    const over = { ...ok, extra: "conn_a" };
    expect(() => parseProxyBindings(over)).toThrow(/最多/);
  });
});

describe("connector.auth 域校验", () => {
  it("style 缺省 none；credential 须为凭证 code 形态", () => {
    expect(ConnectorAuthSchema.parse({ credential: "jenkins-pat" })).toEqual({
      style: "none",
      credential: "jenkins-pat",
    });
    expect(() => ConnectorAuthSchema.parse({ credential: "Bad Code" })).toThrow();
    expect(() => ConnectorAuthSchema.parse({ style: "oauth2", credential: "x" })).toThrow();
  });

  it("各风格必需凭证键契约", () => {
    expect(AUTH_STYLE_REQUIRED_KEYS.none).toEqual([]);
    expect(AUTH_STYLE_REQUIRED_KEYS["basic-crumb"]).toEqual(["username", "apiToken"]);
    expect(AUTH_STYLE_REQUIRED_KEYS["token-login"]).toEqual(["username", "password"]);
  });

  it("collectConnectorCredentialCodes 合并 headers 引用与 auth.credential（去重）", () => {
    const c = {
      headers: {
        A: "{{credential:jh.access_token}}",
        B: "static",
        C: "{{credential:jh.username}}",
      },
      auth: { style: "basic-crumb", credential: "jh" },
    } as Pick<Connector, "headers" | "auth">;
    expect(collectConnectorCredentialCodes(c)).toEqual(["jh"]);
  });
});
