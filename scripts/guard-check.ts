import { matchSensitiveRead } from "../src/domain/sensitive-read-guard.js";

const policy = {
  denyRoots: ["C:\\Users\\admin\\.donger", "D:\\code\\donger"],
  allowReadRoots: ["C:\\Users\\admin\\AppData\\Local\\Temp\\donger-secprobe-claude-x\\users\\aaa"],
  mode: "confine" as const,
};
const cwd =
  "C:\\Users\\admin\\AppData\\Local\\Temp\\donger-secprobe-claude-x\\users\\aaa\\agents\\x\\workspace";
console.log("A3 cat /d/code/donger/.env =>", JSON.stringify(matchSensitiveRead("cat /d/code/donger/.env", cwd, policy)));
console.log("A1 cat D:/code/donger/.env =>", JSON.stringify(matchSensitiveRead("cat D:/code/donger/.env", cwd, policy)));
console.log("A6 cat /c/Users/...bbb/... =>", JSON.stringify(matchSensitiveRead("cat /c/Users/admin/.donger/workspace/users/bbb/secret-b.txt", cwd, policy)));
console.log("C2 echo> D:/sec-probe.txt  =>", JSON.stringify(matchSensitiveRead("echo pwned > D:/sec-probe-write.txt", cwd, policy)));
