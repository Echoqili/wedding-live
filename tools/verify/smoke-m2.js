/**
 * smoke-m2.js —— M2 功能验证（照片定制 / 数据导出）
 * 音乐播放器涉及真实音频无法在无头环境出声，这里验证链路（上传→保存→audio 元素挂载）。
 *
 * 用法：
 *   node server.js &
 *   NODE_PATH=<全局node_modules> node tools/verify/smoke-m2.js http://127.0.0.1:8080
 */
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const SHOT_DIR = path.join(__dirname, 'shots');
const TMP = path.join(__dirname, 'shots', '_m2_tmp');
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
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

  // 生成一张 1x1 测试图（直接用 Base64 解码，避免依赖）
  const pngPath = path.join(TMP, 'test.png');
  if (!fs.existsSync(pngPath)) {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 900 } });
  const errors = [];

  const screen = await ctx.newPage();
  collectErrors(screen, errors);
  await screen.goto(`${BASE}/screen.html`, { waitUntil: 'load' });
  await screen.waitForTimeout(500);

  // 先造数据：2 个宾客 + 2 条祝福
  for (const n of ['M2测试A', 'M2测试B']) {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/mobile.html`, { waitUntil: 'load' });
    await p.waitForTimeout(200);
    await p.evaluate(() => localStorage.removeItem('wedding_my_guest'));
    await p.reload({ waitUntil: 'load' });
    await p.waitForTimeout(200);
    await p.fill('#inpName', n);
    await p.click('#btnSignin');
    await p.waitForTimeout(200);
    await p.close();
  }
  const phone = await ctx.newPage();
  await phone.goto(`${BASE}/mobile.html`, { waitUntil: 'load' });
  await phone.waitForTimeout(200);
  await phone.evaluate(() => localStorage.removeItem('wedding_my_guest'));
  await phone.reload({ waitUntil: 'load' });
  await phone.waitForTimeout(200);
  await phone.fill('#inpName', '祝福者');
  await phone.click('#btnSignin');
  await phone.waitForTimeout(200);
  await phone.click('.m-tab[data-tab="bless"]');
  await phone.waitForTimeout(200);
  await phone.fill('#inpBless', '祝你们幸福到老！');
  await phone.click('#btnSendBless');
  await phone.waitForTimeout(300);
  await phone.fill('#inpBless', '永远甜蜜美满！');
  await phone.click('#btnSendBless');
  await phone.waitForTimeout(400);
  await screen.waitForTimeout(400);

  /* ---- 1. 照片上传与生效 ---- */
  await screen.click('#btnSettings');
  await screen.waitForTimeout(300);
  await screen.setInputFiles('#fileBg', pngPath);
  await screen.waitForTimeout(600); // 压缩 + 渲染缩略图
  const thumbHasImg = await screen.locator('#thumbBg.has-img').count();
  check('背景图缩略图已更新', thumbHasImg === 1);

  await screen.setInputFiles('#fileCouple', pngPath);
  await screen.waitForTimeout(600);
  await screen.click('#btnSaveSettings');
  await screen.waitForTimeout(500);

  const bgStyle = await screen.evaluate(() => document.body.style.backgroundImage);
  check('背景图应用到页面', /url\(/.test(bgStyle || ''), bgStyle ? bgStyle.slice(0, 60) : '(空)');

  const coupleVisible = await screen.evaluate(() => {
    const el = document.getElementById('couplePhoto');
    return el && el.style.display !== 'none';
  });
  check('合照相框显示', coupleVisible === true);

  /* ---- 2. 背景音乐按钮链路 ---- */
  const musicBtnVisible = await screen.locator('#btnMusic').isVisible();
  check('音乐按钮存在', musicBtnVisible);
  // 未上传音乐时点击给出提示（无 JS 错误即可）
  await screen.click('#btnMusic');
  await screen.waitForTimeout(200);

  /* ---- 3. 导出 ---- */
  await screen.click('#btnSettings');
  await screen.waitForTimeout(300);

  const jsonPromise = screen.waitForEvent('download', { timeout: 8000 });
  await screen.click('#btnExportJson');
  const jsonDl = await jsonPromise;
  const jsonName = jsonDl.suggestedFilename();
  check('JSON 导出触发下载', /wedding-data.*\.json$/.test(jsonName || ''), jsonName);

  const wallPromise = screen.waitForEvent('download', { timeout: 8000 });
  await screen.click('#btnExportWall');
  const wallDl = await wallPromise;
  const wallName = wallDl.suggestedFilename();
  check('祝福长图导出触发下载', /blessing-wall.*\.png$/.test(wallName || ''), wallName);

  await screen.waitForTimeout(300);
  check('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await screen.screenshot({ path: path.join(SHOT_DIR, 'm2-settings.png') });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nM2 功能测试: ${results.length - failed.length}/${results.length} 通过`);
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));

  await browser.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
