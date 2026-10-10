import { describe, expect, it } from "vitest";
import { matchesHostExecAllowlist } from "../../src/domain/host-exec-allowlist.js";

const READ_ONLY = ["systemctl is-active", "systemctl show", "curl -s", "journalctl -u"];

describe("matchesHostExecAllowlist", () => {
  it("空白名单/空命令一律不放行", () => {
    expect(matchesHostExecAllowlist("systemctl is-active x", [])).toBe(false);
    expect(matchesHostExecAllowlist("systemctl is-active x", ["  ", ""])).toBe(false);
    expect(matchesHostExecAllowlist("  ", READ_ONLY)).toBe(false);
  });

  it("单段前缀命中放行；前缀不匹配不放行", () => {
    expect(matchesHostExecAllowlist("systemctl is-active stock-analysis", READ_ONLY)).toBe(true);
    expect(matchesHostExecAllowlist("systemctl status ssh", READ_ONLY)).toBe(false);
    expect(matchesHostExecAllowlist("rm -rf /", READ_ONLY)).toBe(false);
  });

  it("组合命令须逐段全命中（2026-10-09 事故命令形态）", () => {
    const cmd =
      "systemctl is-active stock-analysis; systemctl show stock-analysis -p NRestarts 2>/dev/null; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8200/docs";
    expect(matchesHostExecAllowlist(cmd, READ_ONLY)).toBe(true);
    // 任何一段未命中 → 整体不放行
    expect(matchesHostExecAllowlist("systemctl is-active x; systemctl restart y", READ_ONLY)).toBe(
      false,
    );
  });

  it("&&、||、管道、单 &、换行组合同样逐段判定", () => {
    expect(matchesHostExecAllowlist("systemctl is-active a && systemctl show b", READ_ONLY)).toBe(
      true,
    );
    expect(matchesHostExecAllowlist("systemctl is-active a || curl -s x", READ_ONLY)).toBe(true);
    expect(matchesHostExecAllowlist("systemctl is-active a | journalctl -u b", READ_ONLY)).toBe(
      true,
    );
    expect(matchesHostExecAllowlist("systemctl is-active a & systemctl show b", READ_ONLY)).toBe(
      true,
    );
    expect(matchesHostExecAllowlist("systemctl is-active a\ncurl -s b", READ_ONLY)).toBe(true);
    expect(matchesHostExecAllowlist("systemctl is-active a & rm -rf /tmp/x", READ_ONLY)).toBe(
      false,
    );
  });

  it("命令替换（$()与反引号）拒之门外", () => {
    expect(matchesHostExecAllowlist("systemctl show $(echo evil)", READ_ONLY)).toBe(false);
    expect(matchesHostExecAllowlist("systemctl show `whoami`", READ_ONLY)).toBe(false);
  });

  it("进程替换与 here-doc/here-string 拒绝", () => {
    expect(matchesHostExecAllowlist("systemctl show <(evil)", READ_ONLY)).toBe(false);
    expect(matchesHostExecAllowlist("curl -s << EOF\nevil\nEOF", READ_ONLY)).toBe(false);
  });

  it("输出重定向拒绝；>/dev/null 与 2>/dev/null 豁免", () => {
    expect(matchesHostExecAllowlist("systemctl is-active a > /tmp/x", READ_ONLY)).toBe(false);
    expect(matchesHostExecAllowlist("systemctl is-active a >> /tmp/x", READ_ONLY)).toBe(false);
    expect(matchesHostExecAllowlist("systemctl is-active a 2>/dev/null", READ_ONLY)).toBe(true);
    expect(matchesHostExecAllowlist("systemctl is-active a 2> /dev/null", READ_ONLY)).toBe(true);
    expect(matchesHostExecAllowlist("systemctl is-active a >/dev/null", READ_ONLY)).toBe(true);
    // 伪装 /dev/null 路径不豁免
    expect(matchesHostExecAllowlist("systemctl is-active a > /dev/null2", READ_ONLY)).toBe(false);
    expect(matchesHostExecAllowlist("systemctl is-active a > /tmp/dev/null", READ_ONLY)).toBe(
      false,
    );
  });

  it("URL 查询串含 & 时保守回审批（不误放）", () => {
    expect(matchesHostExecAllowlist("curl -s 'http://x/a?b=1&c=2'", READ_ONLY)).toBe(false);
  });
});
