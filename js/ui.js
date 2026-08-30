/**
 * ui.js —— 大屏与手机端共用的 UI 工具
 * 头像渲染、心形布局、图片压缩、Toast、HTML 转义
 */
(function (global) {
  'use strict';

  /* ------------------------------ 头像 ------------------------------ */

  // 预设头像：优先用 emoji，避免全部依赖上传，也规避头像上传失败导致空头像墙
  var PRESET_AVATARS = [
    '🌹', '💐', '🥂', '🍾', '💍', '👰', '🤵', '💒',
    '🎊', '🎉', '🎈', '🎁', '❤️', '💕', '💖', '✨',
    '🌸', '🌺', '🌷', '🌼', '🦋', '🕊️', '⭐', '🌟',
    '🍰', '🍬', '🍭', '🎂', '🐻', '🐰', '🐱', '🐼'
  ];

  /**
   * 渲染头像。avatar 为 dataURL 时渲染图片，否则按 emoji 字符渲染。
   */
  function avatarHTML(avatar, extraClass) {
    var cls = 'avatar' + (extraClass ? ' ' + extraClass : '');
    if (avatar && avatar.length > 12) {
      return '<span class="' + cls + '"><img src="' + avatar + '" alt=""></span>';
    }
    var emo = avatar || PRESET_AVATARS[Math.floor(Math.random() * PRESET_AVATARS.length)];
    return '<span class="' + cls + '">' + emo + '</span>';
  }

  function avatarNode(avatar) {
    var span = document.createElement('span');
    span.className = 'avatar';
    if (avatar && avatar.length > 12) {
      var img = document.createElement('img');
      img.src = avatar;
      img.alt = '';
      span.appendChild(img);
    } else {
      span.textContent = avatar || '🌹';
    }
    return span;
  }

  /** 身份证式随机头像，供「跳过上传」使用 */
  function randomAvatar() {
    return PRESET_AVATARS[Math.floor(Math.random() * PRESET_AVATARS.length)];
  }

  /* --------------------------- 心形布局 --------------------------- */

  /**
   * 在心形区域内生成 n 个均匀分布的归一化坐标。
   *
   * 之前用「网格采样 + 按距离排序取前 N」会让前 N 个点全集中在心形中心。
   * 现在用「对数螺旋 + 心形参数方程」：每个点按黄金角递增、半径按 sqrt(i/n)
   * 递增，N 个点会在心形内呈现类向日葵式的均匀分布。
   *
   * 归一化范围：x ∈ [-1, 1]、y ∈ [-5/16, 5/16]，由调用方换算像素坐标。
   */
  function heartPoints(n) {
    if (n <= 0) return [];
    var out = [];
    var goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var t = i * goldenAngle;
      var r = Math.sqrt((i + 0.5) / n);
      var heartX = r * 16 * Math.pow(Math.sin(t), 3);
      var heartY = r * (13 * Math.cos(t) - 5 * Math.cos(2 * t) -
                         2 * Math.cos(3 * t) - Math.cos(4 * t));
      out.push({ x: heartX / 16, y: heartY / 16 });
    }
    return out;
  }

  /**
   * 计算 n 个嘉宾在心形容器内的像素坐标
   */
  function layoutHeart(n, W, H, avatarSize) {
    if (!n) return [];
    var pts = heartPoints(n);

    var pad = avatarSize * 0.75;
    var availW = W - pad * 2;
    var availH = H - pad * 2;
    // 心形归一化范围：x∈[-1,1]、y∈[-5/16, 5/16]
    var scale = Math.min(availW / 2, availH / 0.62) * 0.85;
    var cx = W / 2;
    var cy = H / 2;

    return pts.map(function (p) {
      return { x: cx + p.x * scale, y: cy - p.y * scale };
    });
  }

  /* --------------------------- 图片压缩 --------------------------- */

  /**
   * 压缩上传图片，输出 dataURL。
   * 婚礼现场可能有上百人上传，原图直接存 localStorage 会撑爆配额，
   * 这里统一压到 maxSize 见方、JPEG 质量 0.72。
   */
  function compressImage(file, maxSize, cb) {
    maxSize = maxSize || 120;
    if (!file || !/^image\//.test(file.type)) {
      cb(null, '不是图片文件');
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { cb(null, '读取失败'); };
    reader.onload = function (e) {
      var img = new Image();
      img.onerror = function () { cb(null, '图片解析失败'); };
      img.onload = function () {
        var scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          cb(canvas.toDataURL('image/jpeg', 0.72));
        } catch (err) {
          cb(null, '压缩失败');
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  /* ----------------------------- Toast ----------------------------- */

  function ensureToastWrap() {
    var wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function toast(msg, ms) {
    var wrap = ensureToastWrap();
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s ease, transform .3s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-10px)';
      setTimeout(function () { el.remove(); }, 320);
    }, ms || 2200);
  }

  /* ----------------------------- 工具 ----------------------------- */

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 简易敏感词过滤：现场大屏，防止出现不合时宜内容 */
  var BAD_WORDS = ['傻逼', '煞笔', '去死', '滚蛋', ' fuck', 'fuck ', '妈的', '贱'];
  function filterText(text) {
    var out = String(text || '');
    BAD_WORDS.forEach(function (w) {
      if (out.indexOf(w) >= 0) {
        out = out.split(w).join('*'.repeat(w.length));
      }
    });
    return out;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 现场口令验证弹层（P1-4）。
   * 全内联样式，不依赖各端 CSS，大屏 / 控台 / 手机都能用。
   * @param {string} correct 正确口令（4 位数字）
   * @param {function(boolean)} cb 结果回调
   * @param {string} [title]
   */
  function askPasscode(correct, cb, title) {
    var mask = document.createElement('div');
    mask.style.cssText =
      'position:fixed;inset:0;background:rgba(10,2,5,.75);display:flex;' +
      'align-items:center;justify-content:center;z-index:9999;';

    var box = document.createElement('div');
    box.style.cssText =
      'width:20rem;max-width:86vw;background:#3a1520;border:1px solid rgba(212,175,55,.45);' +
      'border-radius:16px;padding:1.6rem;text-align:center;box-shadow:0 16px 50px rgba(0,0,0,.5);';

    var input = document.createElement('input');
    input.type = 'password';
    input.maxLength = 4;
    input.placeholder = '4 位数字口令';
    input.style.cssText =
      'width:100%;padding:.85rem;border-radius:8px;border:1.5px solid rgba(212,175,55,.45);' +
      'background:rgba(0,0,0,.35);color:#fff;font-size:1.3rem;text-align:center;outline:none;' +
      'letter-spacing:.4em;box-sizing:border-box;';

    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:.7rem;margin-top:1.1rem;justify-content:center;';

    var cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.className = 'btn btn-ghost';
    var ok = document.createElement('button');
    ok.textContent = '确定';
    ok.className = 'btn btn-gold';
    ok.style.cssText = 'min-width:6rem';

    box.innerHTML = '<div style="font-size:1.6rem;margin-bottom:.4rem">🔒</div>' +
      '<div style="color:#f3dda1;font-size:1.05rem;margin-bottom:1rem;font-weight:600">' +
      (title || '请输入现场口令') + '</div>';
    box.appendChild(input);
    btns.appendChild(cancel);
    btns.appendChild(ok);
    box.appendChild(btns);
    mask.appendChild(box);
    document.body.appendChild(mask);

    function close() {
      mask.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); cb(false); }
      if (e.key === 'Enter') ok.click();
    }
    ok.onclick = function () {
      if ((input.value || '').trim() === String(correct)) {
        close();
        cb(true);
      } else {
        input.style.borderColor = '#e06666';
        input.value = '';
        input.focus();
        toast('口令错误，请重试');
      }
    };
    cancel.onclick = function () { close(); cb(false); };
    document.addEventListener('keydown', onKey);
    setTimeout(function () { input.focus(); }, 60);
  }

  global.UI = {
    PRESET_AVATARS: PRESET_AVATARS,
    avatarHTML: avatarHTML,
    avatarNode: avatarNode,
    randomAvatar: randomAvatar,
    layoutHeart: layoutHeart,
    compressImage: compressImage,
    toast: toast,
    askPasscode: askPasscode,
    escapeHtml: escapeHtml,
    filterText: filterText,
    formatTime: formatTime
  };
})(window);
