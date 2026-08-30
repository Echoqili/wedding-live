/**
 * smoke-host.js —— 主持控台（P0-4）端到端验证
 *
 * 场景：主持人手机（host.html）遥控大屏（screen.html），两者都连 ws。
 *
 * 用法：
 *   node server.js &
 *   NODE_PATH=<全局node_modules> node tools/verify/smoke-host.js http://127.0.0.1:8080
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

  // 清残留
  const WS = require('ws');
  await new Promise((resolve) => {
    const clean = new WS(WS_URL);
    clean.on('open', () => clean.send(JSON.stringify({ type: 'reset' })));
    clean.on('close', resolve);
    clean.on('message', resolve);
    setTimeout(resolve, 1200);
  });

  const browser = await chromium.launch();
  const ctxScreen = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const ctxHost = await browser.newContext({ viewport: { width: 420, height: 850 } });
  const errors = { screen: [], host: [] };

  const screen = await ctxScreen.newPage();
  collectErrors(screen, errors.screen);
  await screen.goto(`${BASE}/screen.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await screen.waitForTimeout(600);

  const host = await ctxHost.newPage();
  collectErrors(host, errors.host);
  await host.goto(`${BASE}/host.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await host.waitForTimeout(600);

  const hdText = await host.locator('#hdNames').textContent();
  check('控台标题显示新人名', /新郎/.test(hdText || ''), hdText);

  /* 1) 遥控切换舞台 */
  await host.click('.h-btn[data-stage="game"]');
  await host.waitForTimeout(400);
  let gamePanelActive = false;
  try {
    await screen.waitForFunction(
      () => document.getElementById('panelGame').classList.contains('active'),
      { timeout: 3000 }
    );
    gamePanelActive = true;
  } catch (e) { /* noop */ }
  check('控台切到摇一摇 → 大屏跟随', gamePanelActive);

  await host.click('.h-btn[data-stage="lottery"]');
  await host.waitForTimeout(400);
  let lotteryActive = false;
  try {
    await screen.waitForFunction(
      () => document.getElementById('panelLottery').classList.contains('active'),
      { timeout: 3000 }
    );
    lotteryActive = true;
  } catch (e) { /* noop */ }
  check('控台切到抽奖 → 大屏跟随', lotteryActive);

  /* 2) 遥控抽奖：加 5 个宾客，host 开始/停止滚动，大屏出中奖者 */
  for (let i = 0; i < 5; i++) {
    const p = await ctxHost.newPage();
    await p.goto(`${BASE}/mobile.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
    await p.waitForTimeout(300);
    await p.evaluate(() => localStorage.removeItem('wedding_my_guest'));
    await p.reload({ waitUntil: 'load' });
    await p.waitForTimeout(250);
    await p.fill('#inpName', '宾客' + i);
    await p.click('#btnSignin');
    await p.waitForTimeout(250);
    await p.close();
  }
  await screen.waitForTimeout(500);

  // host 选择奖项（默认第一个已选中），开始滚动
  const prizeBtn = host.locator('#prizeBtns [data-prize]').first();
  await prizeBtn.click();
  await host.waitForTimeout(200);
  await host.click('#btnDrawToggle');   // 开始
  await host.waitForTimeout(500);

  let rollingOnScreen = false;
  try {
    await screen.waitForFunction(
      () => document.querySelectorAll('.roll-slot.rolling').length > 0,
      { timeout: 3000 }
    );
    rollingOnScreen = true;
  } catch (e) { /* noop */ }
  check('控台开始滚动 → 大屏出现滚动名单', rollingOnScreen);

  await host.click('#btnDrawToggle');   // 停止
  await host.waitForTimeout(600);

  let winnersOnScreen = false;
  try {
    await screen.waitForFunction(
      () => document.querySelectorAll('.winner-chip').length > 0,
      { timeout: 3000 }
    );
    winnersOnScreen = true;
  } catch (e) { /* noop */ }
  check('控台停止滚动 → 大屏产生中奖者', winnersOnScreen);

  /* 3) 遥控游戏 */
  await host.click('.h-btn[data-stage="game"]');
  await host.waitForTimeout(300);
  await host.click('#btnGameStart');
  await host.waitForTimeout(800);

  let cdShown = false;
  try {
    await screen.waitForFunction(
      () => {
        const el = document.getElementById('gameCountdown');
        return el && !el.classList.contains('hidden');
      },
      { timeout: 4000 }
    );
    cdShown = true;
  } catch (e) { /* noop */ }
  check('控台开始游戏 → 大屏进入倒计时', cdShown);

  // 控台自身状态同步
  const hostGameState = await host.locator('#gameState').textContent();
  check('控台显示游戏状态', /准备|进行|结束/.test(hostGameState || ''), hostGameState);

  /* 4) 遥控弹幕 */
  const danmakuTextBefore = await host.locator('#btnDanmaku').textContent();
  await host.click('#btnDanmaku');
  await host.waitForTimeout(400);
  const danmakuTextAfter = await host.locator('#btnDanmaku').textContent();
  check('控台切换弹幕开关', danmakuTextBefore !== danmakuTextAfter,
    danmakuTextBefore + ' → ' + danmakuTextAfter);

  /* 5) 错误与截图 */
  check('大屏端无 JS 错误', errors.screen.length === 0, errors.screen.slice(0, 3).join(' | '));
  check('控台端无 JS 错误', errors.host.length === 0, errors.host.slice(0, 3).join(' | '));

  await host.screenshot({ path: path.join(SHOT_DIR, 'host-console.png') });
  await screen.screenshot({ path: path.join(SHOT_DIR, 'host-screen-game.png') });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n主持控台测试: ${results.length - failed.length}/${results.length} 通过`);
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));

  await browser.close().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
