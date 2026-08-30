/**
 * qrcode.js —— 零依赖二维码生成器（Byte 模式）
 *
 * 现场不一定有外网，不能引 CDN 上的 qrcode 库，所以这里内置一份精简实现。
 * 支持版本 1-10、纠错等级 L/M/Q/H，输出布尔矩阵，再由调用方渲染成 SVG 或 Canvas。
 *
 * 实现遵循 ISO/IEC 18004，用到的关键表：
 *   - ECC_CODEWORDS_PER_BLOCK：每个版本的纠错块划分
 *   - ALIGNMENT_PATTERN_POS：对齐图案中心坐标
 */
(function (global) {
  'use strict';

  /* --------------------------- GF(256) 有限域 --------------------------- */

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** 生成 α^0..α^(degree-1) 为根的多项式，索引 0 为最高次项 */
  function genPoly(degree) {
    var g = [1];
    for (var i = 0; i < degree; i++) {
      var ng = new Array(g.length + 1);
      for (var k = 0; k < ng.length; k++) ng[k] = 0;
      for (var j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gfMul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  /** Reed-Solomon 余数 */
  function rsRemainder(data, ecLen) {
    var gen = genPoly(ecLen);
    var res = new Array(data.length + ecLen);
    for (var i = 0; i < data.length; i++) res[i] = data[i];
    for (var m = data.length; m < res.length; m++) res[m] = 0;

    for (var p = 0; p < data.length; p++) {
      var coef = res[p];
      if (coef === 0) continue;
      for (var q = 0; q < gen.length; q++) {
        res[p + q] ^= gfMul(gen[q], coef);
      }
    }
    return res.slice(data.length);
  }

  /* ------------------------------ 规格表 ------------------------------ */

  // [纠错码字/块, 组1块数, 组1数据码字, 组2块数, 组2数据码字]，下标 = 版本-1
  var RS_BLOCK_TABLE = {
    L: [
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
      [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
      [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]
    ],
    M: [
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]
    ],
    Q: [
      [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
      [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 3, 18, 2, 19],
      [20, 4, 16, 1, 17], [24, 6, 19, 2, 20]
    ],
    H: [
      [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
      [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
      [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]
    ]
  };

  // 对齐图案中心坐标（版本 1-10）
  var ALIGN_POS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  var EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function getFormatBits(ecLevel, mask) {
    var data = (EC_BITS[ecLevel] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
  }

  function getVersionBits(version) {
    var rem = version;
    for (var i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    return ((version << 12) | rem) & 0x3ffff;
  }

  /* ------------------------------ 编码 ------------------------------ */

  function utf8Bytes(str) {
    var out = [];
    var enc = encodeURIComponent(str);
    var i = 0;
    while (i < enc.length) {
      if (enc[i] === '%') {
        out.push(parseInt(enc.substr(i + 1, 2), 16));
        i += 3;
      } else {
        out.push(enc.charCodeAt(i));
        i++;
      }
    }
    return out;
  }

  function getTotalDataBytes(version, ecLevel) {
    var t = RS_BLOCK_TABLE[ecLevel][version - 1];
    return t[1] * t[2] + t[3] * t[4];
  }

  function chooseVersion(byteLen, ecLevel) {
    for (var v = 1; v <= 10; v++) {
      if (byteLen + (v < 10 ? 2 : 2) <= getTotalDataBytes(v, ecLevel)) return v;
    }
    return -1;
  }

  /** 构造完整码字流（数据码字 + 纠错码字，已按块交织） */
  function buildCodewords(dataBytes, version, ecLevel) {
    var t = RS_BLOCK_TABLE[ecLevel][version - 1];
    var ecLen = t[0];
    var totalData = getTotalDataBytes(version, ecLevel);

    // 1) 位流：模式指示符 + 字符计数 + 数据 + 终止符
    var bits = [];
    function push(value, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    }
    push(4, 4);                    // byte mode
    push(dataBytes.length, 8);     // 版本 1-9 字符计数为 8 位（版本 10 也是 8 位 for byte mode）
    dataBytes.forEach(function (b) { push(b, 8); });

    var capacityBits = totalData * 8;
    var termLen = Math.min(4, capacityBits - bits.length);
    for (var i = 0; i < termLen; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    // 2) 填充字节 0xEC / 0x11 交替
    var dataWords = [];
    for (var j = 0; j < bits.length; j += 8) {
      var b = 0;
      for (var k = 0; k < 8; k++) b = (b << 1) | bits[j + k];
      dataWords.push(b);
    }
    var pads = [0xec, 0x11];
    var pi = 0;
    while (dataWords.length < totalData) dataWords.push(pads[pi++ % 2]);

    // 3) 分块
    var blocks = [];
    var offset = 0;
    for (var g = 0; g < t[1]; g++) {
      blocks.push(dataWords.slice(offset, offset + t[2]));
      offset += t[2];
    }
    for (var g2 = 0; g2 < t[3]; g2++) {
      blocks.push(dataWords.slice(offset, offset + t[4]));
      offset += t[4];
    }

    // 4) 每块算纠错
    var ecBlocks = blocks.map(function (blk) {
      return rsRemainder(blk, ecLen);
    });

    // 5) 交织：先按列取数据码字，再按列取纠错码字
    var result = [];
    var maxDataLen = Math.max.apply(null, blocks.map(function (b) { return b.length; }));
    for (var c = 0; c < maxDataLen; c++) {
      blocks.forEach(function (blk) {
        if (c < blk.length) result.push(blk[c]);
      });
    }
    for (var c2 = 0; c2 < ecLen; c2++) {
      ecBlocks.forEach(function (blk) { result.push(blk[c2]); });
    }
    return result;
  }

  /* ---------------------------- 矩阵构造 ---------------------------- */

  function buildMatrix(version, ecLevel, codewords) {
    var size = version * 4 + 17;
    var m = [];
    var reserved = [];
    var r, c;
    for (r = 0; r < size; r++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }

    function setFn(x, y, val) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      m[y][x] = val;
      reserved[y][x] = true;
    }

    // 定位图案（三个角）
    function finder(ox, oy) {
      for (var dy = -1; dy <= 7; dy++) {
        for (var dx = -1; dx <= 7; dx++) {
          var x = ox + dx, y = oy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          var inRing = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
                       (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6));
          var inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          setFn(x, y, (inRing || inCore) ? 1 : 0);
        }
      }
    }
    finder(0, 0);
    finder(size - 7, 0);
    finder(0, size - 7);

    // 时序图案
    for (var i = 8; i < size - 8; i++) {
      setFn(i, 6, (i % 2 === 0) ? 1 : 0);
      setFn(6, i, (i % 2 === 0) ? 1 : 0);
    }

    // 对齐图案
    var pos = ALIGN_POS[version - 1];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var cx = pos[a], cy = pos[b];
        // 与定位图案重叠的三个位置跳过
        if ((cx === 6 && cy === 6) ||
            (cx === 6 && cy === size - 7) ||
            (cx === size - 7 && cy === 6)) continue;
        for (var dy2 = -2; dy2 <= 2; dy2++) {
          for (var dx2 = -2; dx2 <= 2; dx2++) {
            var v = (Math.abs(dx2) === 2 || Math.abs(dy2) === 2 ||
                     (dx2 === 0 && dy2 === 0)) ? 1 : 0;
            setFn(cx + dx2, cy + dy2, v);
          }
        }
      }
    }

    // 预留格式信息区 + 暗模块
    for (var f = 0; f <= 8; f++) {
      if (f !== 6) { setFn(f, 8, 0); setFn(8, f, 0); }
    }
    for (var f2 = 0; f2 < 8; f2++) {
      setFn(size - 1 - f2, 8, 0);
      setFn(8, size - 1 - f2, 0);
    }
    setFn(8, size - 8, 1); // 暗模块

    // 版本信息（版本 >= 7）
    if (version >= 7) {
      var vbits = getVersionBits(version);
      for (var vi = 0; vi < 18; vi++) {
        var bit = (vbits >>> vi) & 1;
        var qr = Math.floor(vi / 3), qc = vi % 3;
        setFn(size - 11 + qc, qr, bit);
        setFn(qc, size - 11 + qr, bit);
      }
    }

    return { matrix: m, reserved: reserved, size: size };
  }

  function placeData(m, reserved, codewords) {
    var size = m.length;
    var bitIndex = 0;
    var total = codewords.length * 8;

    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过竖直时序图案所在的列
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (reserved[y][x]) continue;
          var bit = 0;
          if (bitIndex < total) {
            bit = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
          m[y][x] = bit;
        }
      }
    }
  }

  var MASK_FNS = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return (i * j) % 2 + (i * j) % 3 === 0; },
    function (i, j) { return ((i * j) % 2 + (i * j) % 3) % 2 === 0; },
    function (i, j) { return ((i + j) % 2 + (i * j) % 3) % 2 === 0; }
  ];

  function applyMask(m, reserved, mask) {
    var fn = MASK_FNS[mask];
    for (var y = 0; y < m.length; y++) {
      for (var x = 0; x < m.length; x++) {
        if (!reserved[y][x] && fn(y, x)) m[y][x] ^= 1;
      }
    }
  }

  function writeFormatBits(m, ecLevel, mask) {
    var size = m.length;
    var bits = getFormatBits(ecLevel, mask);
    // 第一份：围绕左上定位图案
    for (var i = 0; i < 15; i++) {
      var bit = (bits >>> i) & 1;
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
    }
    // 第二份：右上 + 左下
    for (var j = 0; j < 15; j++) {
      var b2 = (bits >>> j) & 1;
      if (j < 8) m[8][size - 1 - j] = b2;
      else m[size - 15 + j][8] = b2;
    }
    m[size - 8][8] = 1; // 暗模块
  }

  /** 惩罚评分：连续同色、2x2 同色块、类定位图案、黑白比例 */
  function penalty(m) {
    var size = m.length;
    var score = 0;

    // 规则 1：行/列连续 5 个以上同色
    function lineScore(get) {
      var s = 0;
      for (var a = 0; a < size; a++) {
        var runLen = 1;
        for (var b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) {
            runLen++;
          } else {
            if (runLen >= 5) s += runLen - 2;
            runLen = 1;
          }
        }
        if (runLen >= 5) s += runLen - 2;
      }
      return s;
    }
    score += lineScore(function (a, b) { return m[a][b]; });
    score += lineScore(function (a, b) { return m[b][a]; });

    // 规则 2：2x2 同色块
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }

    // 规则 3：1:1:3:1:1 且前后有 4 格空白的类定位图案
    var PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    function matchPat(arr, start) {
      for (var k = 0; k < 11; k++) {
        if (arr[start + k] !== PAT[k]) return false;
      }
      return true;
    }
    for (var ry = 0; ry < size; ry++) {
      for (var rx = 0; rx <= size - 11; rx++) {
        var row = [], col = [];
        for (var t = 0; t < 11; t++) { row.push(m[ry][rx + t]); col.push(m[rx + t][ry]); }
        if (matchPat(row, 0)) score += 40;
        if (matchPat(col, 0)) score += 40;
      }
    }

    // 规则 4：黑模块占比偏离 50% 的惩罚
    var dark = 0;
    for (var y2 = 0; y2 < size; y2++) {
      for (var x2 = 0; x2 < size; x2++) if (m[y2][x2]) dark++;
    }
    var ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

    return score;
  }

  /**
   * 生成二维码布尔矩阵
   * @param {string} text
   * @param {'L'|'M'|'Q'|'H'} ecLevel
   * @param {number} [forceMask] 指定掩码 0-7（调试 / 与第三方实现比对时使用）
   * @returns {number[][]}
   */
  function matrix(text, ecLevel, forceMask) {
    ecLevel = ecLevel || 'M';
    var bytes = utf8Bytes(text);
    var version = chooseVersion(bytes.length, ecLevel);
    if (version < 0) throw new Error('内容过长：超出版本 10 的容量，请缩短链接');

    var cw = buildCodewords(bytes, version, ecLevel);
    var built = buildMatrix(version, ecLevel, cw);
    placeData(built.matrix, built.reserved, cw);

    // 8 种掩码各算一次惩罚分，取最低者。
    // 注意：每轮必须从「未掩码」的原始数据重新拷贝，否则会叠加多次掩码导致码图错误。
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      if (forceMask != null && mask !== forceMask) continue;
      var candidate = built.matrix.map(function (row) { return row.slice(); });
      applyMask(candidate, built.reserved, mask);
      writeFormatBits(candidate, ecLevel, mask);
      var s = penalty(candidate);
      if (s < bestScore) { bestScore = s; best = candidate; }
    }
    return best;
  }

  /**
   * 渲染成 SVG 字符串
   * @param {string} text
   * @param {{ecLevel?:string, margin?:number, scale?:number, dark?:string, light?:string}} opts
   */
  function svg(text, opts) {
    opts = opts || {};
    var m = matrix(text, opts.ecLevel || 'M');
    var n = m.length;
    var margin = opts.margin == null ? 4 : opts.margin;
    var scale = opts.scale || 8;
    var dim = (n + margin * 2) * scale;

    var path = [];
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (m[y][x]) path.push('M' + (x + margin) + ',' + (y + margin) + 'h1v1h-1z');
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
      '" viewBox="0 0 ' + (n + margin * 2) + ' ' + (n + margin * 2) + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="' + (opts.light || '#ffffff') + '"/>' +
      '<path d="' + path.join('') + '" fill="' + (opts.dark || '#000000') + '"/>' +
      '</svg>';
  }

  function canvas(el, text, opts) {
    opts = opts || {};
    var m = matrix(text, opts.ecLevel || 'M');
    var n = m.length;
    var margin = opts.margin == null ? 2 : opts.margin;
    var total = n + margin * 2;
    var px = Math.max(1, Math.floor((opts.size || 200) / total));
    el.width = total * px;
    el.height = total * px;
    var ctx = el.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff';
    ctx.fillRect(0, 0, el.width, el.height);
    ctx.fillStyle = opts.dark || '#000000';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (m[y][x]) ctx.fillRect((x + margin) * px, (y + margin) * px, px, px);
      }
    }
  }

  global.QRCode = { matrix: matrix, svg: svg, canvas: canvas };
})(window);
