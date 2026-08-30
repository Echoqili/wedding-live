/**
 * 端到端冒烟测试
 *
 * 用同一 browser context 打开多个页面，模拟「1 块大屏 + N 部手机」的真实场景。
 * 同 context 下页面共享 origin，BroadcastChannel 与 localStorage 可以互通，
 * 因此能真实验证跨设备（这里是跨标签）同步链路。
 *
 * 用法：
 *   NODE_PATH=<全局node_modules> node tools/verify/smoke.js [baseUrl]
 */
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const SHOT_DIR = path.join(__dirname, 'shots');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function collectErrors(page, bag) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bag.push('console: ' + msg.text());
  });
  page.on('pageerror', (err) => bag.push('pageerror: ' + err.message));
}

/**
 * 新开一个「宾客」页面。
 *
 * 注意：同一 browser context 内的页面共享 localStorage，若直接打开会沿用
 * 上一位宾客的身份（产品上这是对的——同一台设备刷新后应保持登录）。
 * 为了让多部「手机」各自身份独立，这里先清掉本地身份再重载。
 * 之所以仍放在同一 context，是因为跨 context 时 BroadcastChannel 不通，
 * 也就测不到同步链路。
 */
async function newGuestPage(context, name, errors) {
  const p = await context.newPage();
  collectErrors(p, errors);
  await p.goto(`${BASE}/mobile.html`, { waitUntil: 'load' });
  await p.evaluate(() => localStorage.removeItem('wedding_my_guest'));
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(200);
  if (name) {
    await p.fill('#inpName', name);
    await p.click('#btnSignin');
    await p.waitForTimeout(250);
  }
  return p;
}

async function main() {
  const { chromium } = require('playwright');

  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  const screenErrors = [];
  const mobileErrors = [];

  /* ---------------- 大屏 ---------------- */
  const screen = await context.newPage();
  collectErrors(screen, screenErrors);
  await screen.goto(`${BASE}/screen.html`, { waitUntil: 'load' });
  await screen.waitForTimeout(600);

  check('大屏页面加载无 JS 错误', screenErrors.length === 0, screenErrors.join(' | '));

  const qrSvg = await screen.locator('#qrcode svg').count();
  check('二维码已渲染', qrSvg === 1);

  const qrPath = await screen.locator('#qrcode svg path').getAttribute('d').catch(() => '');
  check('二维码 path 非空', !!qrPath && qrPath.length > 100, `长度 ${qrPath ? qrPath.length : 0}`);

  const qrUrlText = await screen.locator('#qrUrl').textContent();
  check('二维码指向 mobile.html', /mobile\.html$/.test((qrUrlText || '').trim()), qrUrlText);

  /* ---------------- 手机 A ---------------- */
  const phoneA = await newGuestPage(context, null, mobileErrors);
  await phoneA.fill('#inpName', '张小美');
  await phoneA.click('.avatar-opt >> nth=3');
  await phoneA.click('#btnSignin');
  await phoneA.waitForTimeout(400);

  const mainVisible = await phoneA.locator('#pageMain').isVisible();
  check('手机端签到后进入主页', mainVisible);

  // 大屏应通过 BroadcastChannel 收到签到
  let synced = true;
  try {
    await screen.waitForFunction(
      () => document.getElementById('statGuests').textContent === '1',
      { timeout: 3000 }
    );
  } catch (e) {
    synced = false;
  }
  check('大屏同步到签到人数', synced,
    '实际显示 ' + (await screen.locator('#statGuests').textContent()));

  const wallCount = await screen.locator('.wall-avatar').count();
  check('头像墙出现宾客头像', wallCount === 1, `数量 ${wallCount}`);

  /* ---------------- 手机 B ---------------- */
  const phoneB = await newGuestPage(context, '李大强', mobileErrors);

  // 再加 6 位宾客，凑够抽奖人数
  const names = ['王芳', '刘洋', '陈静', '赵磊', '孙丽', '周涛'];
  for (const n of names) {
    const p = await newGuestPage(context, n, mobileErrors);
    await p.close();
  }
  await screen.waitForTimeout(500);

  const guestCount = await screen.locator('.wall-avatar').count();
  check('头像墙累计 8 位宾客', guestCount === 8, `实际 ${guestCount}`);

  /* ---------------- 祝福 ---------------- */
  await phoneA.click('.m-tab[data-tab="bless"]');
  await phoneA.click('.quick-item >> nth=0');
  await phoneA.click('#btnSendBless');
  await phoneA.waitForTimeout(400);

  let blessShown = true;
  try {
    await screen.waitForFunction(
      () => document.querySelectorAll('#blessList .bless-item').length >= 1,
      { timeout: 3000 }
    );
  } catch (e) {
    blessShown = false;
  }
  check('大屏收到祝福', blessShown);

  const blessText = await screen.locator('#blessList .bless-item .tx').first().textContent();
  check('祝福内容正确', /新婚快乐/.test(blessText || ''), blessText);

  const danmakuCount = await screen.locator('.danmaku-item').count();
  check('触发弹幕飘屏', danmakuCount >= 1, `弹幕数 ${danmakuCount}`);

  /* ---------------- 抽奖 ---------------- */
  await screen.click('.stage-tab[data-stage="lottery"]');
  await screen.waitForTimeout(300);
  await screen.click('#btnDraw');
  await screen.waitForTimeout(500);

  const rollingSlots = await screen.locator('.roll-slot.rolling').count();
  check('抽奖进入滚动状态', rollingSlots >= 1, `滚动槽位 ${rollingSlots}`);

  await screen.click('#btnDraw');
  await screen.waitForTimeout(600);

  const wonSlots = await screen.locator('.roll-slot.won').count();
  check('抽奖停止并产生中奖者', wonSlots >= 1, `中奖槽位 ${wonSlots}`);

  const winnerChips = await screen.locator('.winner-chip').count();
  check('中奖名单已记录', winnerChips >= 1, `记录数 ${winnerChips}`);

  // 再次抽取应排除已中奖者
  const poolBefore = await screen.locator('.prize-tab .left').first().textContent();
  check('候选池已扣除中奖者', /剩\s*\d+/.test(poolBefore || ''), poolBefore);

  /* ---------------- 摇一摇 ---------------- */
  await screen.click('.stage-tab[data-stage="game"]');
  await screen.waitForTimeout(200);
  await screen.click('#btnStartGame');
  await screen.waitForTimeout(600);

  const cdVisible = await screen.locator('#gameCountdown').isVisible();
  check('游戏进入倒计时', cdVisible);

  // 等倒计时结束（3 秒）进入 running
  await screen.waitForFunction(
    () => {
      const el = document.getElementById('gameTimer');
      return el && !el.classList.contains('hidden');
    },
    { timeout: 6000 }
  ).catch(() => {});

  const timerVisible = await screen.locator('#gameTimer').isVisible();
  check('游戏进入进行中', timerVisible);

  await phoneA.click('.m-tab[data-tab="game"]');
  await phoneB.click('.m-tab[data-tab="game"]');
  await phoneA.waitForTimeout(200);

  // 模拟摇动：手机 A 点 12 次，手机 B 点 7 次
  for (let i = 0; i < 12; i++) {
    await phoneA.click('#shakeCircle');
    await phoneA.waitForTimeout(140);
  }
  for (let i = 0; i < 7; i++) {
    await phoneB.click('#shakeCircle');
    await phoneB.waitForTimeout(140);
  }
  await screen.waitForTimeout(600);

  const raceRows = await screen.locator('.race-row').count();
  check('大屏出现排名', raceRows >= 1, `排名行 ${raceRows}`);

  const topName = await screen.locator('.race-row .race-name').first().textContent();
  check('榜首为摇动最多的宾客', (topName || '').indexOf('张小美') >= 0, `榜首 ${topName}`);

  const topScore = await screen.locator('.race-row .race-score').first().textContent();
  check('榜首分数接近 12', Math.abs(parseInt(topScore, 10) - 12) <= 2, `分数 ${topScore}`);

  /* ---------------- 截图 ---------------- */
  await screen.click('.stage-tab[data-stage="game"]');
  await screen.waitForTimeout(300);
  await screen.screenshot({ path: path.join(SHOT_DIR, 'screen-game.png') });

  await screen.click('.stage-tab[data-stage="wall"]');
  await screen.waitForTimeout(800);
  await screen.screenshot({ path: path.join(SHOT_DIR, 'screen-wall.png') });

  await screen.click('.stage-tab[data-stage="lottery"]');
  await screen.waitForTimeout(400);
  await screen.screenshot({ path: path.join(SHOT_DIR, 'screen-lottery.png') });

  await phoneA.click('.m-tab[data-tab="bless"]');
  await phoneA.waitForTimeout(300);
  await phoneA.screenshot({ path: path.join(SHOT_DIR, 'mobile-bless.png') });

  /* ---------------- 错误汇总 ---------------- */
  check('手机端无 JS 错误', mobileErrors.length === 0, mobileErrors.slice(0, 3).join(' | '));
  check('大屏端全程无 JS 错误', screenErrors.length === 0, screenErrors.slice(0, 3).join(' | '));

  // 先出结论再关闭浏览器：close() 在某些环境下会挂起，不能让它挡住结果
  const failed = results.filter((r) => !r.ok);
  console.log(`\n测试结果: ${results.length - failed.length}/${results.length} 通过`);
  console.log('截图目录:', SHOT_DIR);
  if (failed.length) {
    console.log('\n失败项:');
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  } else {
    console.log('冒烟测试全部通过');
  }

  await browser.close().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
