/**
 * server.js —— 真机跨设备同步服务（并发安全版）
 *
 * 用法：
 *   1. cd wedding-live
 *   2. npm i                       （安装 ws）
 *   3. node server.js             （默认 8080 端口）
 *
 * 并发设计（P0-1）——为什么不能把整份 state 到处广播：
 *   200 位宾客的 state 含 base64 头像可达 1MB，摇一摇 50 人 × 8条/秒
 *   全量广播 = 400MB/s，直接打爆千兆局域网。因此：
 *   a) 头像走 POST /upload 落盘，state 里只存 URL（~20 字节）
 *   b) 摇分走 {type:'score'} 轻量消息，服务端聚合，每 200ms 广播一次纯数字 map
 *   c) 普通 state 广播做 100ms 合并，同一时刻只发最新版
 *
 * 持久化（P0-2）：state 与摇分成绩防抖 500ms 写入 data/state.json，
 *   重启自动加载。中奖与祝福随 state 一并保存，断电不丢。
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
const DATA_DIR = path.join(ROOT, 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const MAX_STATE_BYTES = 3 * 1024 * 1024;   // 单份 state 上限 3MB（头像未外置时的兜底）
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;  // 单张头像上限 2MB
const STATE_MERGE_MS = 100;                // state 广播合并窗口
const SCORES_MERGE_MS = 200;               // 摇分聚合广播周期

/* -------------------------- 持久化 -------------------------- */

let currentState = null;
let currentSeq = 0;
let scores = {};               // 服务端权威的摇分聚合（仅 running 期间使用）
let scoresDirty = false;
let saveTimer = null;

function loadPersisted() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw.state) {
      currentState = raw.state;
      currentSeq = raw.seq || 0;
      scores = raw.scores || {};
      console.log(`[persist] 已从磁盘恢复状态（seq=${currentSeq}，` +
        `签到 ${currentState.guests.length} 人）`);
    }
  } catch (e) {
    console.error('[persist] 恢复失败，将使用空状态:', e.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        state: currentState,
        scores: scores,
        seq: currentSeq,
        savedAt: Date.now()
      }));
    } catch (e) {
      console.error('[persist] 写盘失败:', e.message);
    }
  }, 500);
}

loadPersisted();

/* -------------------------- HTTP 服务 -------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 头像允许浏览器缓存（文件名含唯一 id，内容不可变）
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (filePath.startsWith(AVATAR_DIR)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(data);
  });
}

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  /* -- 头像上传：POST /upload  body: {"data":"data:image/jpeg;base64,..."} -- */
  if (urlPath === '/upload' && req.method === 'POST') {
    let body = '';
    let tooLarge = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_UPLOAD_BYTES && !tooLarge) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('image too large');
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const j = JSON.parse(body);
        const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(j.data || '');
        if (!m) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('invalid image data');
          return;
        }
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const file = 'avatar_' + Date.now().toString(36) +
          '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        fs.mkdirSync(AVATAR_DIR, { recursive: true });
        fs.writeFileSync(path.join(AVATAR_DIR, file), Buffer.from(m[2], 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: '/avatars/' + file }));
        console.log('[upload] 已保存', file);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('bad request');
      }
    });
    return;
  }

  /* -- 头像访问 -- */
  if (urlPath.startsWith('/avatars/')) {
    const file = path.normalize(urlPath);
    const full = path.join(ROOT, file);
    if (!full.startsWith(AVATAR_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    serveFile(res, full);
    return;
  }

  /* -- 静态文件 -- */
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, filePath);
});

/* -------------------------- WebSocket 同步 -------------------------- */

const wss = new WebSocket.Server({ server: httpServer });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach(function (c) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

/* state 广播合并：100ms 窗口内的多次更新只发最新版 */
let pendingState = null;
let stateMergeTimer = null;
function broadcastStateMerged() {
  if (!pendingState) return;
  currentSeq++;
  broadcast({ type: 'state', state: pendingState, seq: currentSeq });
  pendingState = null;
  scheduleSave();
}

/* 摇分聚合广播：每 200ms 一次纯数字 map */
setInterval(() => {
  if (!scoresDirty) return;
  scoresDirty = false;
  broadcast({ type: 'scores', scores: scores });
  scheduleSave();
}, SCORES_MERGE_MS);

wss.on('connection', (ws) => {
  if (currentState) {
    ws.send(JSON.stringify({ type: 'state', state: currentState, seq: currentSeq }));
    if (Object.keys(scores).length) {
      ws.send(JSON.stringify({ type: 'scores', scores: scores }));
    }
  } else {
    ws.send(JSON.stringify({
      type: 'state',
      state: null,
      seq: 0,
      hint: '服务端暂无状态，任意客户端首次 update 将初始化'
    }));
  }

  ws.on('message', (raw) => {
    // 大消息直接拒收：正常 state（头像外置后）只有几十 KB，
    // 超限说明有客户端在往 state 里塞 base64，提醒而不是静默转发打爆带宽
    if (raw.length > MAX_STATE_BYTES) {
      console.warn('[ws] 拒收超大消息', (raw.length / 1024).toFixed(0) + 'KB');
      return;
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'state': {
        if (!msg.state) return;

        /* 摇分权威同步规则：
           - 游戏 running 期间：以服务端聚合为准，忽略 state 里的 scores
             （否则慢到的全量广播会回滚刚聚合的分数）
           - 非 running（开局重置 / 结算）：用 state 里的 scores 对齐服务端 */
        if (msg.state.game && msg.state.game.state === 'running') {
          msg.state.game.scores = scores;
        } else if (msg.state.game) {
          scores = msg.state.game.scores || {};
          scoresDirty = true;
        }

        currentState = msg.state;
        // 合并广播：窗口内后到的覆盖先到的
        pendingState = currentState;
        if (!stateMergeTimer) {
          stateMergeTimer = setTimeout(() => {
            stateMergeTimer = null;
            broadcastStateMerged();
          }, STATE_MERGE_MS);
        }
        break;
      }

      case 'score': {
        /* 摇分轻量协议：客户端已判断游戏 running，服务端直接聚合 */
        const id = msg.guestId;
        if (typeof id !== 'string') return;
        const delta = Math.max(-5, Math.min(5, parseInt(msg.delta, 10) || 1));
        scores[id] = (scores[id] || 0) + delta;
        scoresDirty = true;
        break;
      }

      case 'scoresSync': {
        /* 游戏开始/重置时客户端显式同步（清空） */
        scores = msg.scores || {};
        scoresDirty = true;
        break;
      }

      case 'pull': {
        if (currentState) {
          ws.send(JSON.stringify({ type: 'state', state: currentState, seq: currentSeq }));
        }
        break;
      }

      case 'reset': {
        currentState = null;
        currentSeq = 0;
        scores = {};
        broadcast({ type: 'reset' });
        scheduleSave();
        try { fs.unlinkSync(STATE_FILE); } catch (e) { /* 文件不存在忽略 */ }
        console.log('[ws] 收到重置指令，已清空服务端状态');
        break;
      }
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', function () {
  console.log('\n=== 婚礼互动服务已启动（并发安全版）===');
  console.log('  本地访问：  http://localhost:' + PORT + '/');
  console.log('  手机扫码：  http://<电脑局域网IP>:' + PORT + '/');
  console.log('  主持控台：  http://<电脑局域网IP>:' + PORT + '/host.html?ws=ws://<电脑局域网IP>:' + PORT);
  console.log('  数据目录：  ' + DATA_DIR);
  console.log('  退出：      Ctrl+C\n');
  console.log('手机端必须带 ?ws= 参数才会走真机同步，例如：');
  console.log('  http://192.168.1.100:' + PORT + '/mobile.html?ws=ws://192.168.1.100:' + PORT);
  console.log();
});
