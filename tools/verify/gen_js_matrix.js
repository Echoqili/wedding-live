/**
 * 用 Node 加载 js/qrcode.js，输出各测试用例在 8 种掩码下的矩阵，供 Python 侧比对。
 * 用法：node tools/verify/gen_js_matrix.js <输出json路径>
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'js', 'qrcode.js'), 'utf8');
const QRCode = new Function('window', src + ';return window.QRCode;')({});

const CASES = [
  'http://192.168.1.100:8080/m',
  'https://wedding.example.com/m?sid=abc123',
  'HELLO',
  '新郎李雷 & 新娘韩梅梅 婚礼快乐',
  'a'.repeat(80),
  'https://example.com/a-fairly-long-wedding-invitation-link-with-params?from=screen&t=1234567890'
];

const out = {};
for (const text of CASES) {
  const perMask = {};
  for (let m = 0; m < 8; m++) {
    try {
      perMask[m] = QRCode.matrix(text, 'M', m);
    } catch (e) {
      perMask[m] = 'ERROR: ' + e.message;
    }
  }
  // 也记录未指定掩码时的自动选择结果
  try {
    perMask['auto'] = QRCode.matrix(text, 'M');
  } catch (e) {
    perMask['auto'] = 'ERROR: ' + e.message;
  }
  out[text] = perMask;
}

const target = process.argv[2] || path.join(__dirname, 'js_matrices.json');
fs.writeFileSync(target, JSON.stringify(out));
console.log('written:', target);
console.log('cases:', CASES.length);
