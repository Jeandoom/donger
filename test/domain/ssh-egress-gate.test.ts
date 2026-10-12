import { describe, expect, it } from "vitest";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";

describe("ssh-egress gate（旁门治理 M2）", () => {
  const gates = createDefaultGates();

  it("ssh/scp/sftp/sshpass 段首命令位命中 force 门", () => {
    const cases = [
      "ssh ubuntu@10.0.0.5 uptime",
      "ssh.exe host cmd",
      "scp app.tar.gz ubuntu@host:/srv/app/",
      "sftp user@host",
      "sshpass -p x ssh host cmd",
      "cd /srv && ssh host ./deploy.sh",
      "(ssh host; echo done)",
      "git fetch origin || ssh host check.sh",
    ];
    for (const command of cases) {
      const hit = gates.match("Bash", { command });
      expect(hit?.gateId, command).toBe("ssh-egress");
      expect(hit?.force, command).toBe(true);
    }
  });

  it("非段首/非 ssh 语义不误伤：git ssh 远程、echo 参数、deploy 门各行其道", () => {
    expect(gates.match("Bash", { command: "git push ssh://x/repo.git main" })?.gateId).toBe(
      "deploy",
    );
    expect(gates.match("Bash", { command: "echo ssh is a tool" })).toBeUndefined();
    expect(gates.match("Bash", { command: "cat docs/ssh-guide.md" })).toBeUndefined();
    expect(gates.match("Bash", { command: "grep -r sshpass ./src" })).toBeUndefined();
    // donger-host 正门工具不进 Bash 门
    expect(gates.match("mcp__donger-host__host_exec", { command: "x" })?.gateId).toBe("host-ops");
  });

  it("host-ops 门保持原语义（回归）", () => {
    expect(gates.match("mcp__donger-host__host_exec", { hostCode: "x" })?.force).toBe(true);
    expect(gates.match("mcp__donger-host__host_logs_clean", {})?.gateId).toBe("host-ops");
  });
});
