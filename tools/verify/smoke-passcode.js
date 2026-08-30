/**
 * smoke-passcode.js —— 现场口令鉴权（P1-4）端到端验证
 *
 * 场景：
 *   1. 未设置口令时，host 操作直接放行（不弹框）
 *   2. 设置口令 8888 后：
 *      a. host 首次操作弹口令框，错误口令 → 操作不执行
 *      b. 正确口令 → 操作执行，会话内不再询问
 *      c. 大屏危险操作（清空中奖）同样需口令
 *
 * 用法：
 *   node server.js &
 *   NODE_PATH=<全局node_modules> node tools/verify/smoke-passcode.js http://127.0.0.1:8080
 */
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_URL = (BASE.startsWith('https') ? 'wss' : 'ws') + '://' +
  BASE.replace(/^https?:\/\//, '');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function fillPasscodeBox(page, value) {
  const input = page.locator('input[type="password"]');
  await input.fill(value);
  const okBtn = page.locator('button', { hasText: '确定' }).first();
  await okBtn.click();
}

async function main() {
  const { chromium } = require('playwright');

  // 清残留（ws 模式持久化可能干扰）
  const WS = require('ws');
  await new Promise((resolve) => {
    const c = new WS(WS_URL);
    c.on('open', () => c.send(JSON.stringify({ type: 'reset' })));
    c.on('close', resolve);
    c.on('message', resolve);
    setTimeout(resolve, 1200);
  });

  const browser = await chromium.launch();
  const ctxScreen = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const ctxHost = await browser.newContext({ viewport: { width: 420, height: 850 } });
  const errors = [];

  const screen = await ctxScreen.newPage();
  screen.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  screen.on('pageerror', (e) => errors.push(e.message));
  await screen.goto(`${BASE}/screen.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await screen.waitForTimeout(500);

  const host = await ctxHost.newPage();
  host.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  host.on('pageerror', (e) => errors.push(e.message));
  await host.goto(`${BASE}/host.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await host.waitForTimeout(500);

  /* ---- 1. 未设置口令：直接放行 ---- */
  await host.click('.h-btn[data-stage="game"]');
  await host.waitForTimeout(300);
  const passBoxAfter = await host.locator('input[type="password"]').count();
  check('未设置口令时操作直接执行（不弹口令框）', passBoxAfter === 0);

  /* ---- 2. 设置口令 8888 ---- */
  await screen.click('#btnSettings');
  await screen.waitForTimeout(300);
  await screen.fill('#cfgPasscode', '8888');
  await screen.click('#btnSaveSettings');
  await screen.waitForTimeout(400);

  // 等 host 同步到新 state
  await host.waitForTimeout(400);

  /* ---- 3. host 操作需口令，错误口令被拒 ---- */
  await host.click('.h-btn[data-stage="lottery"]');
  await host.waitForTimeout(400);
  const passBoxShown = await host.locator('input[type="password"]').count();
  check('设置口令后 host 操作弹出口令框', passBoxShown === 1);

  await fillPasscodeBox(host, '0000');
  await host.waitForTimeout(400);
  // 错误口令后弹层保持打开（设计如此），先点取消关闭
  await host.locator('button', { hasText: '取消' }).first().click();
  await host.waitForTimeout(200);
  // 错误口令后舞台应保持 game（未切换）
  const gameStillActive = await screen.evaluate(() =>
    document.getElementById('panelGame').classList.contains('active'));
  check('错误口令 → 操作未执行（舞台未切换）', gameStillActive === true);

  /* ---- 4. 正确口令 → 执行，且会话内不再询问 ---- */
  await host.click('.h-btn[data-stage="lottery"]');
  await host.waitForTimeout(300);
  const passBox2 = await host.locator('input[type="password"]').count();
  check('再次操作仍会询问（会话未验证）', passBox2 === 1);
  await fillPasscodeBox(host, '8888');
  await host.waitForTimeout(500);
  const lotteryActive = await screen.evaluate(() =>
    document.getElementById('panelLottery').classList.contains('active'));
  check('正确口令 → 舞台切换成功', lotteryActive === true);

  // 已验证：后续操作不再弹框
  await host.click('.h-btn[data-stage="game"]');
  await host.waitForTimeout(400);
  const passBox3 = await host.locator('input[type="password"]').count();
  check('验证后会话内不再询问', passBox3 === 0);

  /* ---- 5. 大屏危险操作需口令 ---- */
  // 造一条中奖记录
  const phone = await ctxHost.newPage();
  await phone.goto(`${BASE}/mobile.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await phone.waitForTimeout(300);
  await phone.evaluate(() => localStorage.removeItem('wedding_my_guest'));
  await phone.reload({ waitUntil: 'load' });
  await phone.waitForTimeout(250);
  await phone.fill('#inpName', '鉴权测试');
  await phone.click('#btnSignin');
  await phone.waitForTimeout(250);
  await phone.close();

  await screen.click('.stage-tab[data-stage="lottery"]');
  await screen.waitForTimeout(300);
  await screen.click('#btnDraw');
  await screen.waitForTimeout(400);
  await screen.click('#btnDraw');
  await screen.waitForTimeout(500);
  const winners = await screen.locator('.winner-chip').count();
  check('已有一条中奖记录', winners >= 1, `中奖 ${winners}`);

  // 清空中奖：confirm + 口令框
  await screen.click('#btnSettings');
  await screen.waitForTimeout(300);
  screen.once('dialog', (d) => d.accept()); // 确认弹窗
  await screen.click('#btnClearWinners');
  await screen.waitForTimeout(400);
  const screenPassBox = await screen.locator('input[type="password"]').count();
  check('大屏危险操作弹出口令框', screenPassBox === 1);
  await fillPasscodeBox(screen, '8888');
  await screen.waitForTimeout(500);
  const winnersAfter = await screen.locator('.winner-chip').count();
  check('正确口令后中奖记录被清空', winnersAfter === 0, `剩余 ${winnersAfter}`);

  check('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n口令鉴权测试: ${results.length - failed.length}/${results.length} 通过`);
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));

  await browser.close().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
