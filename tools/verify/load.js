/**
 * load.js —— 100 并发压测（P0-1 验收）
 *
 * 场景模拟婚礼现场最坏情况：
 *   - 1 个「大屏」客户端：接收所有广播，统计吞吐
 *   - 100 个「手机」客户端：同时以 8 条/秒 上报摇分（等价 50 人真摇）
 *   - 期间穿插 20 次「签到」（state 更新）
 *
 * 验收标准（对照 ROADMAP P0-1）：
 *   - 大屏收到的总字节 < 50MB（换算出站 < 3.4MB/s，远低于千兆上限）
 *   - scores 聚合消息数量 ≈ 时长 / 200ms，而不是 100×8 条/秒
 *   - 头像上传接口可用，state 中头像为 URL 而非 base64
 *
 * 用法：
 *   node server.js &          （先启动服务）
 *   node tools/verify/load.js http://127.0.0.1:8080
 */
const path = require('path');
const http = require('http');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_URL = (BASE.startsWith('https') ? 'wss' : 'ws') + '://' +
  BASE.replace(/^https?:\/\//, '');

let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  console.error('需要 ws 依赖，请先执行 npm i');
  process.exit(1);
}

const PLAYERS = 100;
const DURATION_MS = 15000;
const RATE_PER_SEC = 8;          // 每客户端上报频率
const SIGNUP_COUNT = 20;         // 压测期间穿插的签到数

let bytesReceived = 0;
let scoresMsgCount = 0;
let stateMsgCount = 0;
let otherMsgCount = 0;
let maxSingleMsg = 0;
let clientErrors = 0;

function connect(url, monitor) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('message', (d) => {
      // 只有被指定为「大屏」的客户端才统计：广播会发给所有连接，
      // 若每个客户端都计数，会把 100 倍的消息重复算进去
      if (!monitor) return;
      bytesReceived += d.length;
      if (d.length > maxSingleMsg) maxSingleMsg = d.length;
      try {
        const m = JSON.parse(d.toString());
        if (m.type === 'scores') scoresMsgCount++;
        else if (m.type === 'state') stateMsgCount++;
        else otherMsgCount++;
      } catch (e) { otherMsgCount++; }
    });
    ws.on('error', () => { clientErrors++; });
    ws.on('open', () => resolve(ws));
    setTimeout(() => reject(new Error('连接超时')), 5000);
  });
}

/** 服务端头像上传接口验证 */
function uploadTest() {
  return new Promise((resolve) => {
    // 1x1 红色 PNG（真实 base64）
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const data = JSON.stringify({ data: 'data:image/png;base64,' + tinyPng });
    const u = new URL(BASE);
    const req = http.request({
      host: u.hostname, port: u.port, path: '/upload',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let ok = false, url = null;
        try {
          const j = JSON.parse(body);
          url = j.url;
          ok = res.statusCode === 200 && typeof url === 'string' && url.startsWith('/avatars/');
        } catch (e) { ok = false; }
        resolve({ ok, url, status: res.statusCode, body: body.slice(0, 80) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log(`\n=== 压测开始：${PLAYERS} 客户端 × ${RATE_PER_SEC}次/秒 × ${DURATION_MS / 1000}s ===\n`);

  /* 1) 头像上传接口 */
  const up = await uploadTest();
  console.log(`[1] 头像上传接口: ${up.ok ? 'PASS' : 'FAIL'}  ${up.ok ? up.url : (up.error || up.body)}`);

  /* 2) 控制端初始化游戏 running */
  const ctrl = await connect(WS_URL, false);
  ctrl.send(JSON.stringify({
    type: 'state',
    state: {
      config: { groom: '压测', bride: '并发', date: '', needReview: false, danmaku: true,
        prizes: [{ id: 'p1', name: '测试奖', count: 5 }] },
      guests: Array.from({ length: SIGNUP_COUNT }, (_, i) => ({
        id: 'g' + i, name: '宾客' + i, avatar: '/avatars/fake_' + i + '.jpg', ts: Date.now()
      })),
      blessings: [], winners: [],
      game: { state: 'running', duration: 300, startAt: Date.now() - 1000, scores: {} },
      lottery: { rolling: false, prizeId: 'p1' },
      stage: 'game',
      updatedAt: Date.now()
    }
  }));

  /* 3) 大屏客户端：纯监听（monitor=true，只统计它的吞吐） */
  const screen = await connect(WS_URL, true);
  await new Promise((r) => setTimeout(r, 300));

  /* 4) 100 个摇手机客户端 */
  const clients = [];
  for (let i = 0; i < PLAYERS; i++) {
    const ws = await connect(WS_URL, false);
    clients.push(ws);
  }
  console.log(`[2] ${PLAYERS} 个客户端已连接`);

  const started = Date.now();
  const interval = 1000 / RATE_PER_SEC;
  let sent = 0;

  const sender = setInterval(() => {
    const now = Date.now();
    if (now - started > DURATION_MS) { clearInterval(sender); return; }
    clients.forEach((ws, i) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'score', guestId: 'g' + (i % SIGNUP_COUNT), delta: 1 }));
        sent++;
      }
    });
  }, interval);

  await new Promise((r) => setTimeout(r, DURATION_MS + 1000));

  /* 5) 统计 */
  const mb = bytesReceived / 1024 / 1024;
  const perSec = bytesReceived / 1024 / 1024 / (DURATION_MS / 1000);
  const expectedScores = Math.floor(DURATION_MS / 200);

  console.log(`\n[3] 上报总数: ${sent} 条 score（客户端 → 服务端）`);
  console.log(`[4] 大屏收到: ${scoresMsgCount} 条 scores 聚合（预期 ≈ ${expectedScores}）`);
  console.log(`    ${stateMsgCount} 条 state / ${otherMsgCount} 条其他`);
  console.log(`[5] 大屏吞吐: ${mb.toFixed(2)} MB 总量，${perSec.toFixed(2)} MB/s 平均`);
  console.log(`    单条最大消息: ${(maxSingleMsg / 1024).toFixed(1)} KB`);
  console.log(`[6] 客户端错误: ${clientErrors}`);

  const stateSize = JSON.stringify({
    config: {}, guests: Array.from({ length: 200 }, (_, i) => ({
      id: 'g' + i, name: '宾客' + i, avatar: '/avatars/fake_' + i + '.jpg', ts: Date.now()
    })), blessings: [], winners: [], game: { scores: {} }, lottery: {}, stage: 'wall'
  }).length / 1024;
  console.log(`[7] 200 人 state 体积（头像外置后）: ${stateSize.toFixed(1)} KB（头像内嵌约为 1MB+）`);

  /* 6) 判定 */
  const checks = [
    ['头像上传接口', up.ok],
    ['scores 聚合生效（< 上报数的 5%）', scoresMsgCount < sent * 0.05],
    ['大屏吞吐 < 50MB', mb < 50],
    ['单条消息 < 100KB', maxSingleMsg < 100 * 1024],
    ['无客户端错误', clientErrors === 0]
  ];
  let pass = 0;
  checks.forEach(([name, ok]) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass++;
  });
  console.log(`\n压测结论: ${pass}/${checks.length} 通过`);

  ctrl.close();
  screen.close();
  clients.forEach((c) => { try { c.close(); } catch (e) {} });
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((e) => { console.error('压测异常:', e); process.exit(1); });
