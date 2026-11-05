// 桥协议实验：验证 codex 对桥内联 function_call+function_call_output 对、
// 双下划线展平名、tool_name nsarg 三种形态的接受度
// 用法: node tmp-mock-probe.cjs <mode>   mode: e1|e2|e3
const http = require('node:http');
const mode = process.argv[2] || 'e1';
const url = 'data:text/html;base64,' + Buffer.from('<html><head><title>probe-' + mode + '</title></head><body>ok</body></html>').toString('base64');

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    try {
      const j = JSON.parse(body);
      const tools = (j.tools || []).map((t) => t.name);
      console.error(`[${mode}] tools(${tools.length}): ${tools.join(',')}`);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    sse(res, 'response.created', { type: 'response.created', response: { id: 'resp_' + mode } });
    if (mode === 'e1') {
      // 内联工具环：已知工具的 call+output 对 + 收尾文本
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_e1', name: 'list_mcp_resources', arguments: '{}' } });
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call_output', call_id: 'call_e1', output: '{"resources":[]}' } });
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 2, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'e1 done' }] } });
    } else if (mode === 'e2') {
      // 双下划线展平名：让 codex 路由 mcp__playwright__browser_navigate
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_e2', name: 'mcp__playwright__browser_navigate', arguments: JSON.stringify({ url }) } });
    } else {
      // nsarg 变体：tool_name 判别字段
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_e3', name: 'mcp__playwright', arguments: JSON.stringify({ tool_name: 'browser_navigate', arguments: { url } }) } });
    }
    sse(res, 'response.completed', { type: 'response.completed', response: { id: 'resp_' + mode, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
});
server.listen(9911, '127.0.0.1', () => console.error('probe on 9911 mode=' + mode));
