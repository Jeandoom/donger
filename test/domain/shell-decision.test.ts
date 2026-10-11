import { describe, expect, it } from "vitest";
import { classifyShellDecision, hasUndecidableShellPattern } from "../../src/domain/shell-decision.js";

describe("shell-decision 三分类管线（INV-6/INV-10）", () => {
  describe("whitelist-quick：只读豁免族免审批", () => {
    const cases = ["git status", "git log --oneline -5 && git diff HEAD~1", "git fetch origin", 'curl -s "https://api.example.com/data"'];
    for (const cmd of cases) {
      it(`免审: ${cmd}`, () => {
        expect(classifyShellDecision(cmd)).toBe("whitelist-quick");
      });
    }
  });

  describe("needs-approval：对抗形态零漏网（探针 B1 实锤形态+边界实验形态）", () => {
    const cases = [
      // base64+eval（探针 B1 穿透形态）
      `node -e "eval(Buffer.from('Y2F0IC9kL2NvZGUvZG9uZ2VyLy5lbnY=','base64').toString())"`,
      // 变量间接
      "cat $P",
      "echo ${HOME}/.env",
      // glob/brace 展开
      "cat /d/*/donger/.env",
      "ls *.ts",
      "echo {a,b} | xargs cat",
      // 重定向
      "echo pwned > /d/sec-probe.txt",
      "cat .env > copy.txt",
      // 解释器/执行乘数（INV-10）
      "node script.js",
      "python -c 'import os'",
      "powershell -c Get-Content D:\\x",
      "env node -e x",
      "bash -s < setup.sh",
      "printf x | base64 -d",
      // 命令替换
      'echo "$(cat /d/code/donger/.env)"',
      "`cat /d/code/donger/.env`",
      // 组合段污染：一段不可判定整体审批
      "git status && node -e x",
    ];
    for (const cmd of cases) {
      it(`审批: ${cmd.slice(0, 60)}`, () => {
        expect(classifyShellDecision(cmd)).toBe("needs-approval");
      });
    }
  });

  describe("static-guard：无展开语义的常规命令走守卫判定", () => {
    const cases = ["cat ./src/index.ts", "cat /d/code/donger/.env", "ls -la ../other-user", "whoami && hostname", "cat .env", "type D:\\code\\donger\\.env"];
    for (const cmd of cases) {
      it(`守卫: ${cmd}`, () => {
        expect(classifyShellDecision(cmd)).toBe("static-guard");
      });
    }
  });

  it("白名单族语义：免审批≠免守卫（守卫路径判定独立于分类器，协作由 e2e 验证）", () => {
    // git log 是只读族 → 分类器给 whitelist；但 /d/code/donger token 的 fsDeny 判定在守卫层独立发生
    expect(classifyShellDecision("git -C /d/code/donger log -p .env")).toBe("whitelist-quick");
  });

  it("hasUndecidableShellPattern 边界", () => {
    expect(hasUndecidableShellPattern("cat file.txt")).toBe(false);
    expect(hasUndecidableShellPattern("echo $HOME")).toBe(true);
    expect(hasUndecidableShellPattern("git log --oneline")).toBe(false);
  });

  it("文件名后缀不误报为解释器（.sh/.env/.cmd 实测教训）", () => {
    // deploy.sh / run.cmd 是文件名参数，不是解释器命令——走静态守卫即可
    expect(classifyShellDecision("./deploy.sh")).toBe("static-guard");
    expect(classifyShellDecision("cat .env")).toBe("static-guard");
    expect(classifyShellDecision("bash deploy.sh")).toBe("needs-approval"); // bash 作命令位
    expect(classifyShellDecision("cmd /c echo hi")).toBe("needs-approval"); // cmd 命令位
    expect(classifyShellDecision("git -C /d/code/donger log -p .env")).toBe("whitelist-quick");
  });
});
