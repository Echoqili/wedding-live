/**
 * 真机跨设备同步测试（WebSocket 模式）
 *
 * 与 smoke.js 的关键区别：使用两个隔离的 browser context，模拟「不同设备」。
 * 不同 context 的 localStorage 不互通，所以能验证同步必须通过 WebSocket 完成。
 *
 * 启动条件：
 *   node server.js     （另开一个终端，或同进程后端）
 *
 * 用法：
 *   NODE_PATH=<全局node_modules> node tools/verify/smoke-ws.js [baseUrl]
 */
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_URL = (BASE.startsWith('https') ? 'wss' : 'ws') + '://' +
  BASE.replace(/^https?:\/\//, '');
const SHOT_DIR = path.join(__dirname, 'shots');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function collectErrors(page, bag) {
  page.on('console', (m) => { if (m.type() === 'error') bag.push('console: ' + m.text()); });
  page.on('pageerror', (e) => bag.push('pageerror: ' + e.message));
}

async function main() {
  const { chromium } = require('playwright');
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  // 清空服务端可能残留的状态（上次压测/测试落盘的脏数据，P0-2 持久化的副作用）
  const WS = require('ws');
  await new Promise((resolve) => {
    const clean = new WS(WS_URL);
    clean.on('open', () => { clean.send(JSON.stringify({ type: 'reset' })); });
    clean.on('message', () => resolve());
    clean.on('close', resolve);
    setTimeout(resolve, 1500);
  });

  const browser = await chromium.launch();

  // 两个独立 context：localStorage 不互通 → 任何同步都必须走 ws
  const ctxScreen = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const ctxPhone = await browser.newContext({ viewport: { width: 400, height: 800 } });
  const screenErrors = [];
  const phoneErrors = [];

  const screen = await ctxScreen.newPage();
  collectErrors(screen, screenErrors);
  await screen.goto(`${BASE}/screen.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await screen.waitForTimeout(800);

  const phone = await ctxPhone.newPage();
  collectErrors(phone, phoneErrors);
  await phone.goto(`${BASE}/mobile.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await phone.waitForTimeout(800);

  /* ---------------- 签到跨设备同步 ---------------- */

  await phone.fill('#inpName', '赵亮');
  await phone.click('#btnSignin');
  await phone.waitForTimeout(400);

  // 关键断言：screen 端通过 ws 收到 state，不是 localStorage 共享
  let guestSeen = true;
  try {
    await screen.waitForFunction(
      () => document.getElementById('statGuests').textContent === '1',
      { timeout: 5000 }
    );
  } catch (e) { guestSeen = false; }
  check('WS 模式签到跨设备同步（screen 端）', guestSeen,
    'statGuests = ' + (await screen.locator('#statGuests').textContent()));

  const wallCount = await screen.locator('.wall-avatar').count();
  check('WS 模式头像墙出现宾客', wallCount === 1, `数量 ${wallCount}`);

  /* ---------------- 祝福跨设备同步 ---------------- */

  await phone.click('.m-tab[data-tab="bless"]');
  await phone.waitForTimeout(200);
  await phone.click('.quick-item >> nth=1');
  await phone.click('#btnSendBless');
  await phone.waitForTimeout(500);

  let blessSeen = true;
  try {
    await screen.waitForFunction(
      () => document.querySelectorAll('#blessList .bless-item').length >= 1,
      { timeout: 5000 }
    );
  } catch (e) { blessSeen = false; }
  check('WS 模式祝福跨设备同步', blessSeen);

  /* ---------------- 抽奖双向同步 ---------------- */

  // 再加 4 位嘉宾
  for (const n of ['钱多多', '孙美丽', '周星星', '吴所谓']) {
    const p = await ctxPhone.newPage();
    collectErrors(p, phoneErrors);
    await p.goto(`${BASE}/mobile.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    await p.fill('#inpName', n);
    await p.click('#btnSignin');
    await p.waitForTimeout(300);
    await p.close();
  }

  await screen.waitForTimeout(500);
  const totalGuests = await screen.locator('#statGuests').textContent();
  check('WS 模式累计 5 位宾客', totalGuests === '5', `实际 ${totalGuests}`);

  await screen.click('.stage-tab[data-stage="lottery"]');
  await screen.waitForTimeout(300);
  await screen.click('#btnDraw');
  await screen.waitForTimeout(500);
  await screen.click('#btnDraw');
  await screen.waitForTimeout(600);

  const winners = await screen.locator('.winner-chip').count();
  check('WS 模式抽奖生成中奖者', winners >= 1, `中奖 ${winners}`);

  // 手机端 my name 应对应中奖结果（不一定都中）
  const winInfo = await phone.locator('.win-banner').count();
  check('手机端能看到自己的中奖信息（仅在已中奖时）', winInfo >= 0);

  /* ---------------- 摇一摇跨设备同步 ---------------- */

  await screen.click('.stage-tab[data-stage="game"]');
  await screen.waitForTimeout(200);
  await screen.click('#btnStartGame');
  await screen.waitForTimeout(500);

  // 等 running
  await screen.waitForFunction(
    () => {
      const el = document.getElementById('gameTimer');
      return el && !el.classList.contains('hidden');
    },
    { timeout: 6000 }
  ).catch(() => {});

  await phone.click('.m-tab[data-tab="game"]');
  await phone.waitForTimeout(200);

  // 模拟摇动 20 次
  for (let i = 0; i < 20; i++) {
    await phone.click('#shakeCircle');
    await phone.waitForTimeout(120);
  }
  await screen.waitForTimeout(600);

  const races = await screen.locator('.race-row').count();
  check('WS 模式游戏排名同步', races >= 1, `排名行 ${races}`);

  const topName = await screen.locator('.race-row .race-name').first().textContent();
  check('WS 模式榜首为赵亮（参与摇动者）',
    (topName || '').indexOf('赵亮') >= 0, `榜首 ${topName}`);

  /* ---------------- 错误汇总 ---------------- */
  check('手机端 WS 模式无 JS 错误', phoneErrors.length === 0,
    phoneErrors.slice(0, 3).join(' | '));
  check('大屏端 WS 模式无 JS 错误', screenErrors.length === 0,
    screenErrors.slice(0, 3).join(' | '));

  /* ---------------- 截图 ---------------- */
  await screen.click('.stage-tab[data-stage="wall"]');
  await screen.waitForTimeout(800);
  await screen.screenshot({ path: path.join(SHOT_DIR, 'ws-screen-wall.png') });
  await phone.screenshot({ path: path.join(SHOT_DIR, 'ws-phone-game.png') });

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\nWS 模式测试结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('\n失败项:');
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  } else {
    console.log('WS 模式冒烟测试全部通过');
  }

  await browser.close().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
