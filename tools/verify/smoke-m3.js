/**
 * smoke-m3.js —— M3 功能验证（投票 / 故事时间线 / 氛围特效）
 *
 * 用法：
 *   node server.js &
 *   NODE_PATH=<全局node_modules> node tools/verify/smoke-m3.js http://127.0.0.1:8080
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

/** 新建一个身份独立的宾客页面 */
async function newGuest(ctx, name, bag) {
  const p = await ctx.newPage();
  collectErrors(p, bag);
  await p.goto(`${BASE}/mobile.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await p.waitForTimeout(300);
  await p.evaluate(() => localStorage.removeItem('wedding_my_guest'));
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(250);
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

  // 清残留
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
  const ctxPhone = await browser.newContext({ viewport: { width: 420, height: 850 } });
  const errors = { screen: [], phone: [] };

  const screen = await ctxScreen.newPage();
  collectErrors(screen, errors.screen);
  await screen.goto(`${BASE}/screen.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await screen.waitForTimeout(500);

  /* ==================== 投票 ==================== */

  // 两位宾客
  const phoneA = await newGuest(ctxPhone, '投票甲', errors.phone);
  const phoneB = await newGuest(ctxPhone, '投票乙', errors.phone);

  // 控台发起"伴娘团哪家强"
  const host = await ctxPhone.newPage();
  collectErrors(host, errors.phone);
  await host.goto(`${BASE}/host.html?ws=${encodeURIComponent(WS_URL)}`, { waitUntil: 'load' });
  await host.waitForTimeout(500);
  await host.click('.h-btn[data-vote] >> nth=0');
  await host.waitForTimeout(500);

  // 大屏切到投票舞台（控台 setStage('vote')）
  let votePanel = false;
  try {
    await screen.waitForFunction(
      () => document.getElementById('panelVote').classList.contains('active'),
      { timeout: 3000 }
    );
    votePanel = true;
  } catch (e) { /* noop */ }
  check('发起投票后大屏自动切到投票舞台', votePanel);

  const qOnScreen = await screen.locator('#voteQuestion').textContent();
  check('大屏显示投票问题', /伴娘团/.test(qOnScreen || ''), qOnScreen);

  // 宾客投票：甲投 A，乙投 B，甲改投 B
  await phoneA.click('.m-tab[data-tab="vote"]');
  await phoneA.waitForTimeout(300);
  await phoneA.locator('#voteOpts [data-opt] >> nth=0').click(); // A
  await phoneA.waitForTimeout(300);
  await phoneB.click('.m-tab[data-tab="vote"]');
  await phoneB.waitForTimeout(300);
  await phoneB.locator('#voteOpts [data-opt] >> nth=1').click(); // B
  await phoneB.waitForTimeout(300);

  let countsAfter2 = '';
  try {
    await screen.waitForFunction(() => {
      const els = document.querySelectorAll('#voteOptions .vote-option .cnt');
      return els.length && els[0].textContent.includes('票') &&
        document.getElementById('voteCount').textContent.includes('2');
    }, { timeout: 4000 });
    countsAfter2 = await screen.locator('#voteCount').textContent();
  } catch (e) { countsAfter2 = '(等待超时)'; }
  check('两人投票后大屏计数为 2', /2 人/.test(countsAfter2), countsAfter2);

  // 甲改投 B → B 两票
  await phoneA.locator('#voteOpts [data-opt] >> nth=1').click();
  await phoneA.waitForTimeout(400);
  let bCount = '';
  try {
    await screen.waitForFunction(() => {
      const opts = Array.from(document.querySelectorAll('#voteOptions .vote-option'));
      return opts.some((el) => {
        const txt = el.querySelector('.txt').textContent;
        const cnt = el.querySelector('.cnt').textContent;
        return txt === 'B伴郎团' && /2 票/.test(cnt);
      });
    }, { timeout: 4000 });
    bCount = await screen.evaluate(() => {
      const el = Array.from(document.querySelectorAll('#voteOptions .vote-option'))
        .find((x) => x.querySelector('.txt').textContent === 'B伴郎团');
      return el ? el.querySelector('.cnt').textContent : '';
    });
  } catch (e) { bCount = '(等待超时)'; }
  check('甲改投后 B 选项 2 票（改投生效）', /2 票/.test(bCount), bCount);

  // 结束投票
  await host.click('#btnEndVoteHost');
  await host.waitForTimeout(500);
  const badge = await screen.locator('#voteBadge').textContent();
  check('结束投票后大屏显示结果态', /已结束/.test(badge || ''), badge);

  /* ==================== 故事时间线 ==================== */

  // 设置里加两条故事
  await screen.click('#btnSettings');
  await screen.waitForTimeout(300);
  await screen.click('#btnAddTimeline');
  await screen.waitForTimeout(200);
  const tlRows = await screen.locator('#timelineEditor .tl-row').count();
  check('时间线编辑器出现空行', tlRows >= 1, `行数 ${tlRows}`);
  // 填两条
  await screen.locator('#timelineEditor .tl-row').nth(0).locator('.tl-year').fill('2018');
  await screen.locator('#timelineEditor .tl-row').nth(0).locator('.tl-title').fill('初识');
  await screen.locator('#timelineEditor .tl-row').nth(0).locator('.tl-desc').fill('图书馆的偶然相遇');
  await screen.click('#btnAddTimeline');
  await screen.waitForTimeout(200);
  await screen.locator('#timelineEditor .tl-row').nth(1).locator('.tl-year').fill('2021');
  await screen.locator('#timelineEditor .tl-row').nth(1).locator('.tl-title').fill('求婚');
  await screen.locator('#timelineEditor .tl-row').nth(1).locator('.tl-desc').fill('在初识的图书馆');
  await screen.click('#btnSaveSettings');
  await screen.waitForTimeout(400);

  // 大屏切故事舞台
  await screen.click('.stage-tab[data-stage="story"]');
  await screen.waitForTimeout(400);
  const storyYear = await screen.locator('#storyYear').textContent();
  const storyTitle = await screen.locator('#storyTitle').textContent();
  check('故事舞台显示第一条大事记', /2018/.test(storyYear || '') && /初识/.test(storyTitle || ''),
    storyYear + ' · ' + storyTitle);

  const dots = await screen.locator('#storyDots .dot').count();
  check('圆点指示器数量正确', dots === 2, `圆点 ${dots}`);

  /* ==================== 氛围特效 ==================== */

  await screen.click('.stage-tab[data-stage="lottery"]');
  await screen.waitForTimeout(300);
  await screen.click('#btnHeartRain');
  await screen.waitForTimeout(400);
  const canvasCount = await screen.locator('.effect-canvas').count();
  check('爱心雨特效 canvas 出现', canvasCount === 1, `canvas ${canvasCount}`);

  // 再点红包雨：应替换旧的（不叠加）
  await screen.click('#btnRedPacket');
  await screen.waitForTimeout(300);
  const canvasCount2 = await screen.locator('.effect-canvas').count();
  check('红包雨替换爱心雨（不叠加）', canvasCount2 === 1, `canvas ${canvasCount2}`);

  check('大屏端无 JS 错误', errors.screen.length === 0, errors.screen.slice(0, 3).join(' | '));
  check('手机/控台端无 JS 错误', errors.phone.length === 0, errors.phone.slice(0, 3).join(' | '));

  await screen.screenshot({ path: path.join(SHOT_DIR, 'm3-vote.png') });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nM3 功能测试: ${results.length - failed.length}/${results.length} 通过`);
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));

  await browser.close().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
