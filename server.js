/**
 * server.js —— 真机跨设备同步服务
 *
 * 用法：
 *   1. cd wedding-live
 *   2. npm i ws                    （或 npm i -g ws）
 *   3. node server.js             （默认 8080 端口）
 *   4. 大屏用 http://电脑IP:8080/screen.html
 *   5. 手机用相同地址 + 打开 ?ws=ws://电脑IP:8080
 *
 * 设计要点：
 *   - 服务端只做「存状态 + 转发」，不解释业务。
 *     这样业务逻辑（Actions）仍只在客户端存在，状态机不会分裂。
 *   - 客户端 update 时立即本地生效（乐观更新），同时把新 state 发给服务端。
 *   - 服务端为每条 state 分配单调递增的 seq，广播时附带。
 *   - 客户端只接受 seq 严格递增的 state，从而在多客户端并发写入时
 *     自然形成 last-write-wins，并保证所有客户端最终看到一致的状态。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');

let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  console.error('缺少依赖 ws，请先执行：npm i ws');
  process.exit(1);
}

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

/* -------------------------- HTTP 静态服务 -------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);

  // 防止越权：禁止跳出项目目录
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* -------------------------- WebSocket 同步 -------------------------- */

const wss = new WebSocket.Server({ server: httpServer });

let currentState = null;   // 服务端权威 state
let currentSeq = 0;        // 单调递增版本号

wss.on('connection', (ws) => {
  // 新连接立即把当前 state 推过去
  if (currentState) {
    ws.send(JSON.stringify({ type: 'state', state: currentState, seq: currentSeq }));
  } else {
    // 还没有任何客户端发来 state，推一个空初始化让客户端拿到 schema
    ws.send(JSON.stringify({
      type: 'state',
      state: null,
      seq: 0,
      hint: '请从大屏端先打开页面以初始化状态'
    }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'state' && msg.state) {
      currentState = msg.state;
      currentSeq++;
      const out = JSON.stringify({ type: 'state', state: currentState, seq: currentSeq });
      wss.clients.forEach(function (c) {
        if (c.readyState === WebSocket.OPEN) c.send(out);
      });
    } else if (msg.type === 'pull' && currentState) {
      ws.send(JSON.stringify({ type: 'state', state: currentState, seq: currentSeq }));
    } else if (msg.type === 'reset') {
      currentState = null;
      currentSeq = 0;
      const out = JSON.stringify({ type: 'reset' });
      wss.clients.forEach(function (c) {
        if (c.readyState === WebSocket.OPEN) c.send(out);
      });
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', function () {
  console.log('\n=== 婚礼互动服务已启动 ===');
  console.log('  本地访问：  http://localhost:' + PORT + '/');
  console.log('  手机扫码：  http://<电脑局域网IP>:' + PORT + '/');
  console.log('  例如：      http://192.168.1.100:' + PORT + '/');
  console.log('  WebSocket： ws://<电脑局域网IP>:' + PORT);
  console.log('  退出：      Ctrl+C\n');
  console.log('手机端必须带 ?ws= 参数才会走真机同步，例如：');
  console.log('  http://192.168.1.100:' + PORT + '/mobile.html?ws=ws://192.168.1.100:' + PORT);
  console.log();
});
