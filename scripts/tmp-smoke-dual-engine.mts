// 双引擎真机冒烟：向指定会话发消息（modelRef=provider:<id>:glm-5.3-flash）并轮询到轮次结束
// 用法: npx tsx scripts/tmp-smoke-dual-engine.mts <convId> <providerId> "<shotName>"
const BASE = 'http://127.0.0.1:3310';
const TOKEN = (await import('node:fs')).readFileSync('C:/Users/admin/AppData/Local/Temp/dual-smoke-token.txt', 'utf8').trim();
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const [convId, providerId, shotName] = process.argv.slice(2);
if (!convId || !providerId) { console.error('usage: tmp-smoke-dual-engine.mts <convId> <providerId> <shotName>'); process.exit(2); }

const html = `<html><head><title>smoke-${shotName}</title></head><body style="font-size:44px"><h1>dual-engine browser e2e</h1></body></html>`;
const dataUrl = 'data:text/html;base64,' + Buffer.from(html).toString('base64');
const text = [
  '请严格使用 playwright 浏览器工具完成三步：',
  `1) 调用 browser_navigate 打开：${dataUrl}`,
  `2) 调用 browser_take_screenshot 截图，文件名 ${shotName}.png，保存到当前工作目录的 .shots/ 子目录`,
  '3) 最后一行回复：页面标题 + 截图文件的相对路径。',
].join('\n');

const send = await fetch(`${BASE}/api/conversations/${convId}/messages`, {
  method: 'POST', headers: H, body: JSON.stringify({ text, modelRef: `provider:${providerId}:glm-5.3-flash` }),
});
const sendBody = await send.text();
console.log(`send http=${send.status} ${String(sendBody).slice(0, 120)}`);
if (!send.ok) process.exit(1);

let lastLen = -1, stable = 0;
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const r = await fetch(`${BASE}/api/conversations/${convId}/messages`, { headers: H });
  const parsed = await r.json().catch(() => undefined);
  const list = Array.isArray(parsed) ? parsed : (parsed?.messages ?? []);
  const bots = list.filter((m: { role: string }) => m.role === 'bot');
  const lastBot = bots.at(-1);
  const size = JSON.stringify(list).length;
  console.log(`poll#${i} msgs=${list.length} bots=${bots.length} bytes=${size}`);
  if (list.length === lastLen && lastBot) {
    stable++;
    if (stable >= 3) {
      const c = typeof lastBot.content === 'string'
        ? lastBot.content
        : (lastBot.content === undefined ? '' : JSON.stringify(lastBot.content)) || '';
      console.log('=== 最终 bot 回复 ===');
      console.log(c.slice(0, 1500));
      process.exit(0);
    }
  } else stable = 0;
  lastLen = list.length;
}
console.log('POLL_TIMEOUT');
process.exit(1);
