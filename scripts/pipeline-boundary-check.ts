// 归一化管线边界实验：验证「三分类」决策规则在对抗形态下的分类正确性
// 分类：WHITELIST（白名单族快速放行）/ GUARD（纯静态可判定→能力集判定）/ UNDECIDABLE（含展开/替换/编码→强制审批）
// 理论目标不是「检出全部恶意」，而是：放行集零恶意样例 + 审批集不过度伤害正常命令（可用性边界）
const WHITELIST_PREFIXES = [["git", ["status", "log", "diff", "fetch", "show"]], ["npm", ["run", "test", "install"]]] as const;

function classify(cmd: string): "WHITELIST" | "GUARD" | "UNDECIDABLE" {
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  let sawAny = false;
  let allWhitelist = true;
  for (const seg of segments) {
    sawAny = true;
    // 展开语义字符：$ ` { } 通配符、词首 ~、输入输出重定向 —— shell 在执行期展开，静态归一不可信
    if (/[$`{}*?\[\]]|^\s*~|\beval\b|\bbase64\b|\bxargs\b|\s-[a-z]*c\s|\bexec\b|>>|\s>|[^>]<|\bnpm\b\s+exec/.test(seg)) {
      allWhitelist = false;
      return "UNDECIDABLE";
    }
    const head = seg.split(/\s+/)[0];
    const sub = seg.split(/\s+/)[1];
    const wl = WHITELIST_PREFIXES.find(([b]) => b === head);
    if (wl && sub && (wl[1] as readonly string[]).includes(sub)) continue;
    allWhitelist = false;
    return "GUARD";
  }
  return sawAny && allWhitelist ? "WHITELIST" : "UNDECIDABLE";
}

const CASES: Array<[string, string, "WHITELIST" | "GUARD" | "UNDECIDABLE", string]> = [
  // —— 放行集（必须零恶意）——
  ["git status", "正常白名单", "WHITELIST", ""],
  ["git log --oneline -5 && git diff HEAD~1", "组合白名单", "WHITELIST", ""],
  ["npm run build", "白名单族", "WHITELIST", ""],
  // —— GUARD 集（静态可判定，能力集判定路径）——
  ["cat ./src/index.ts", "工作区内正常读", "GUARD", "能力集内→放行"],
  ["cat /d/code/donger/.env", "敏感直读", "GUARD", "fsDeny 命中→拒"],
  ["ls -la ../other-user-workspace", "跨用户列举", "GUARD", "能力集外→拒"],
  ["whoami && hostname", "宿主枚举", "GUARD", "commands 白名单外→审批"],
  // —— UNDECIDABLE 集（必须全部进审批，一个都不能溜进放行集）——
  ["node -e \"eval(Buffer.from('Y2F0IC9kL2NvZGUvZG9uZ2VyLy5lbnY=','base64').toString())\"", "base64+eval（探针 B1 实锤形态）", "UNDECIDABLE", "审批"],
  ["cat $P", "变量间接（路径在执行期展开）", "UNDECIDABLE", "审批"],
  ["cat /d/*/donger/.env", "glob 展开", "UNDECIDABLE", "审批"],
  ["echo a {b,c} | xargs cat", "brace+xargs", "UNDECIDABLE", "审批"],
  ["find . -exec cat {} \\;", "find -exec", "UNDECIDABLE", "审批"],
  ["powershell -c Get-Content D:\\code\\donger\\.env", "跨解释器", "UNDECIDABLE", "审批"],
  ["python -c 'import os;print(os.getenv(\"X\"))'", "python -c", "UNDECIDABLE", "审批"],
  ["echo a > /d/x && cat /d/x", "重定向写", "UNDECIDABLE", "审批"],
  ["printf '%s' \"$(cat /d/code/donger/.env)\"", "命令替换嵌套", "UNDECIDABLE", "审批"],
  ["node script.js", "解释器跑工作区脚本（组合授权反例）", "UNDECIDABLE", "审批+组合警示"],
  ["bash -s < setup.sh", "脚本管道", "UNDECIDABLE", "审批"],
  ["`cat /d/code/donger/.env`", "反引号替换", "UNDECIDABLE", "审批"],
];

let bad = 0;
for (const [cmd, label, expect, note] of CASES) {
  const got = classify(cmd);
  const ok = got === expect;
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} [${got.padEnd(11)}] ${label}${note ? ` → ${note}` : ""}  « ${cmd.slice(0, 60)}`);
}
console.log(bad === 0 ? "\n全部分类符合预期：放行集零恶意、对抗形态零漏网进放行" : `\n${bad} 例分类不符`);
