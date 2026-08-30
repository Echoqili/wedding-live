/**
 * screen.js —— 大屏端逻辑
 *
 * 职责：
 *   1. 展示签到头像墙 / 祝福流 / 弹幕
 *   2. 抽奖：滚动名单 + 分奖项抽取 + 中奖去重
 *   3. 摇一摇赛马：倒计时与计时由「主控窗口」推进，避免多开大屏时状态打架
 *
 * 关于主控权：现场可能误开多个大屏窗口，若都去推进游戏倒计时会互相覆盖。
 * 这里用 localStorage 心跳（5 秒超时）选出唯一主控，只有主控推进计时。
 */
(function () {
  'use strict';

  // 根据 URL 上的 ?ws= 参数决定用 LocalStore（单机多窗口）还是 RemoteStore（真机跨设备）
  // 注意：这里不能调用 UI.toast，UI 变量在此行之后才赋值
  var store = (function () {
    var params = new URLSearchParams(location.search);
    var wsUrl = params.get('ws');
    if (wsUrl && typeof WeddingRemoteStore !== 'undefined') {
      return new WeddingRemoteStore(wsUrl);
    }
    return WeddingStore.create();
  })();
  var A = WeddingStore.Actions;
  var UI = window.UI;

  var $ = function (id) { return document.getElementById(id); };

  /* ==================== 主控权 ==================== */

  var CONTROLLER_KEY = 'wedding_controller';
  var myId = 'screen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  var isController = false;

  function claimController() {
    var now = Date.now();
    var c = null;
    try { c = JSON.parse(localStorage.getItem(CONTROLLER_KEY) || 'null'); } catch (e) { c = null; }
    if (!c || now - (c.ts || 0) > 5000) {
      c = { id: myId, ts: now };
      localStorage.setItem(CONTROLLER_KEY, JSON.stringify(c));
    }
    isController = (c.id === myId);
  }

  function keepAlive() {
    claimController();
    var c = null;
    try { c = JSON.parse(localStorage.getItem(CONTROLLER_KEY) || 'null'); } catch (e) { c = null; }
    if (isController && c && c.id === myId) {
      c.ts = Date.now();
      localStorage.setItem(CONTROLLER_KEY, JSON.stringify(c));
    }
  }

  claimController();
  setInterval(keepAlive, 2000);

  /* ==================== 全局状态 ==================== */

  var currentStage = 'wall';
  var currentPrizeId = null;
  var rolling = false;
  var rollTimer = null;
  var rollSlots = [];
  var danmakuOn = true;
  var wallNodes = {};        // guestId -> element
  var lastBlessingCount = 0;
  var danmakuTracks = [];    // 每条轨道下次可用时间
  var TRACK_HEIGHT = 60;
  var raceRows = {};         // guestId -> 排名行节点（增量更新用）
  var prizeTabsKey = '';     // 奖项 tab 的脏检查 key
  var winnersKey = '';       // 中奖名单的脏检查 key
  var isWsMode = !!(new URLSearchParams(location.search).get('ws'));
  var audioEl = null;        // 背景音乐
  var musicPlaying = false;
  var pendingPhotos = {};    // 设置面板未保存的照片（key: bg/couple/logo → url 或 base64）
  var pendingMusic = '';

  /* ==================== 初始化 ==================== */

  function init() {
    bindTopbar();
    bindConsole();
    bindLottery();
    bindGame();
    bindSettings();
    bindKeys();
    renderQR();

    // 把当前奖项固化到共享 state：主持控台由此知道大屏选的是哪个奖；
    // ws 模式下这次写入同时完成服务端状态的初始化
    var s0 = store.getState();
    if (s0.config.prizes.length && !(s0.lottery && s0.lottery.prizeId)) {
      A.setLotteryPrize(store, s0.config.prizes[0].id);
    }

    render(true);

    store.subscribe(function () { render(false); });
    setInterval(tickGame, 100);

    // file:// 协议下 BroadcastChannel 与扫码均不可用，必须提示
    if (location.protocol === 'file:') {
      UI.toast('请用本地服务器打开（file:// 无法跨设备同步），详见 README', 8000);
    }
  }

  /* ==================== 二维码 ==================== */

  function renderQR() {
    var base = location.href.replace(/screen\.html.*$/, '');
    var url = base + 'mobile.html';
    $('qrUrl').textContent = url;
    try {
      $('qrcode').innerHTML = QRCode.svg(url, { ecLevel: 'M', margin: 2 });
    } catch (e) {
      $('qrcode').innerHTML = '<div style="color:#a00;font-size:.8rem;padding:1rem">' +
        UI.escapeHtml(e.message) + '</div>';
    }

    // 主持控台二维码（仅 ws 模式可用：控台依赖服务端同步）
    var wsParam = new URLSearchParams(location.search).get('ws');
    var hostWrap = $('hostQrWrap');
    if (hostWrap) {
      if (wsParam) {
        var hostUrl = base + 'host.html?ws=' + encodeURIComponent(wsParam);
        $('hostQr').innerHTML = QRCode.svg(hostUrl, { ecLevel: 'M', margin: 2 });
        hostWrap.classList.remove('hidden');
      } else {
        hostWrap.classList.add('hidden');
      }
    }
  }

  /* ==================== 渲染主入口 ==================== */

  function render(first) {
    var s = store.getState();
    renderHeader(s);
    syncDanmaku(s);
    syncVisuals(s);
    syncMusic(s);
    renderWall(s, first);
    renderBlessings(s);
    renderStats(s);
    syncStageControl(s);
    syncLotteryControl(s);
    renderPrizeTabs(s);
    renderWinners(s);
    renderGame(s);
  }

  /**
   * 舞台遥控（P0-4）：主持控台改 state.stage，大屏跟随切换。
   * switchStage 内部会回写 state，回写后 stage 与 currentStage 相等，
   * 不会形成切换循环。
   */
  function syncStageControl(s) {
    if (s.stage && s.stage !== currentStage &&
        ['wall', 'lottery', 'game'].indexOf(s.stage) >= 0) {
      switchStage(s.stage);
    }
  }

  function renderHeader(s) {
    $('groomName').textContent = s.config.groom || '新郎';
    $('brideName').textContent = s.config.bride || '新娘';
    $('weddingSub').textContent = s.config.date || 'WEDDING PARTY';
  }

  /** 弹幕开关以共享 state 为准（主持控台可切换），这里把状态同步到本地与按钮 */
  function syncDanmaku(s) {
    var want = !(s.config && s.config.danmaku === false);
    danmakuOn = want;
    $('btnDanmaku').style.opacity = want ? '1' : '.45';
  }

  /** 视觉定制应用（M2-1）：背景图 / 合照 / logo */
  function syncVisuals(s) {
    var p = (s.config && s.config.photos) || {};
    var body = document.body;

    if (p.bg) {
      body.style.backgroundImage =
        'linear-gradient(rgba(20,4,8,.45), rgba(20,4,8,.6)), url("' + p.bg + '")';
      body.style.backgroundSize = 'cover';
      body.style.backgroundPosition = 'center';
    } else {
      body.style.backgroundImage = '';
      body.style.backgroundSize = '';
      body.style.backgroundPosition = '';
    }

    var couple = $('couplePhoto');
    if (couple) {
      couple.style.display = p.couple ? 'block' : 'none';
      couple.style.backgroundImage = p.couple ? 'url("' + p.couple + '")' : '';
    }
    var logo = $('logoImg');
    if (logo) {
      logo.style.display = p.logo ? 'block' : 'none';
      logo.style.backgroundImage = p.logo ? 'url("' + p.logo + '")' : '';
    }
  }

  /** 背景音乐同步（M2-2）：单曲循环，播放/暂停由顶栏 🎵 控制 */
  function syncMusic(s) {
    var src = (s.config && s.config.music) || '';
    if (!src) {
      if (audioEl) { audioEl.pause(); }
      musicPlaying = false;
      $('btnMusic').style.opacity = '.45';
      return;
    }
    $('btnMusic').style.opacity = '1';
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.loop = true;
      audioEl.preload = 'auto';
    }
    if (audioEl.getAttribute('data-src') !== src) {
      audioEl.setAttribute('data-src', src);
      audioEl.src = src;
      // 换曲后保持播放状态
      if (musicPlaying) {
        audioEl.play().catch(function () { musicPlaying = false; });
      }
    }
  }

  /**
   * 资源上传（M2-1/M2-2）：ws 模式 POST /upload 存服务端返回 URL；
   * 单机模式直接保留 base64（照片压缩后可控；音频在单机模式不支持）。
   */
  function uploadResource(dataUrl) {
    return new Promise(function (resolve) {
      if (!isWsMode) { resolve(dataUrl); return; }
      fetch(location.origin + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataUrl })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        resolve(j.url || dataUrl);
      }).catch(function () {
        resolve(dataUrl); // 降级
      });
    });
  }

  function renderStats(s) {
    $('statGuests').textContent = s.guests.length;
    $('statBlessings').textContent = s.blessings.filter(function (b) { return b.approved; }).length;
    $('statWinners').textContent = s.winners.length;
  }

  /* ==================== 头像墙 ==================== */

  function renderWall(s, first) {
    var canvas = $('wallCanvas');
    var guests = s.guests;
    var useGrid = guests.length > 300;

    if (!guests.length) {
      $('wallEmpty').classList.remove('hidden');
      // 清空所有节点
      Object.keys(wallNodes).forEach(function (id) {
        wallNodes[id].remove();
        delete wallNodes[id];
      });
      canvas.classList.remove('wall-grid');
      return;
    }
    $('wallEmpty').classList.add('hidden');

    // 网格模式与心形模式切换时重建
    var wantGrid = useGrid;
    var hasGrid = canvas.classList.contains('wall-grid');
    if (wantGrid !== hasGrid) {
      Object.keys(wallNodes).forEach(function (id) {
        wallNodes[id].remove();
        delete wallNodes[id];
      });
      canvas.classList.toggle('wall-grid', wantGrid);
    }

    // 移除已删除的嘉宾
    var alive = {};
    guests.forEach(function (g) { alive[g.id] = true; });
    Object.keys(wallNodes).forEach(function (id) {
      if (!alive[id]) {
        wallNodes[id].remove();
        delete wallNodes[id];
      }
    });

    // 新增节点
    var newcomerIds = [];
    guests.forEach(function (g) {
      if (wallNodes[g.id]) return;
      var el = document.createElement('div');
      el.className = 'wall-avatar' + (first ? '' : ' newcomer');
      el.title = g.name;
      if (g.avatar && g.avatar.length > 12) {
        var img = document.createElement('img');
        img.src = g.avatar;
        img.alt = g.name;
        el.appendChild(img);
      } else {
        var emo = document.createElement('span');
        emo.className = 'emo';
        emo.textContent = g.avatar || UI.randomAvatar();
        el.appendChild(emo);
      }
      canvas.appendChild(el);
      wallNodes[g.id] = el;
      newcomerIds.push(g.id);
    });

    // 网格模式：布局完全交给 CSS，新节点本就追加在末尾，无需重排 DOM
    if (useGrid) return;

    var W = canvas.clientWidth;
    var H = canvas.clientHeight;
    if (!W || !H) return;

    var size = Math.max(34, Math.min(78, Math.round(Math.sqrt((W * H * 0.42) / Math.max(guests.length, 1)))));
    var pts = UI.layoutHeart(guests.length, W, H, size);

    guests.forEach(function (g, i) {
      var el = wallNodes[g.id];
      if (!el || !pts[i]) return;
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.left = pts[i].x + 'px';
      el.style.top = pts[i].y + 'px';
      var emoEl = el.querySelector('.emo');
      if (emoEl) emoEl.style.fontSize = Math.round(size * 0.5) + 'px';
    });

    // 新加入的高亮一阵
    if (newcomerIds.length) {
      setTimeout(function () {
        newcomerIds.forEach(function (id) {
          if (wallNodes[id]) wallNodes[id].classList.remove('newcomer');
        });
      }, 3000);
    }
  }

  /* ==================== 祝福 ==================== */

  function renderBlessings(s) {
    var list = $('blessList');
    var all = s.blessings.slice().reverse(); // 最新在前
    var approved = all.filter(function (b) { return b.approved; });
    var pending = all.filter(function (b) { return !b.approved; });

    $('blessCount').textContent = approved.length + ' 条';

    if (!all.length) {
      list.innerHTML = '<div class="bless-empty">还没有人送祝福<br>扫码后即可写下你的祝福</div>';
      lastBlessingCount = 0;
      // 空列表也要完成初始化，否则第一条祝福会被误判成历史数据而不飘屏
      danmakuPrimed = true;
      return;
    }

    // 只在数量变化时重建 DOM，避免每帧抖动打断滚动
    if (all.length === lastBlessingCount) return;
    lastBlessingCount = all.length;

    var html = '';

    if (pending.length) {
      html += '<div style="font-size:.8rem;color:#ffd28a;padding:.3rem 0 .5rem;' +
        'border-bottom:1px dashed rgba(212,175,55,.3);margin-bottom:.5rem">' +
        '待审核 ' + pending.length + ' 条（下方卡片可通过）</div>';
    }

    all.forEach(function (b) {
      var showActions = !b.approved;
      html += '<div class="bless-item" data-id="' + b.id + '" style="' +
        (b.approved ? '' : 'opacity:.5;border-left-color:#ffd28a;') + '">' +
        UI.avatarHTML(b.avatar) +
        '<div class="body">' +
          '<div class="nm">' + UI.escapeHtml(b.name) +
            (b.approved ? '' : ' <span style="color:#ffd28a">· 待审核</span>') +
          '</div>' +
          '<div class="tx">' + UI.escapeHtml(b.text) + '</div>' +
          (showActions
            ? '<div style="margin-top:.4rem;display:flex;gap:.5rem">' +
              '<button class="btn btn-sm" data-act="approve" data-id="' + b.id +
                '" style="padding:3px 12px;font-size:.75rem;background:rgba(212,175,55,.25);color:#ffe9b0">通过</button>' +
              '<button class="btn btn-sm" data-act="reject" data-id="' + b.id +
                '" style="padding:3px 12px;font-size:.75rem;background:rgba(255,120,120,.2);color:#ffb3b3">删除</button>' +
              '</div>'
            : '') +
        '</div>' +
      '</div>';
    });

    list.innerHTML = html;

    // 弹幕：首次渲染时的历史祝福不补发，之后新通过审核的才飘屏。
    // 用 id 集合而不是条数判断，避免「第一条祝福」被初始化逻辑吞掉。
    if (!danmakuPrimed) {
      all.forEach(function (b) { danmakuSentIds[b.id] = true; });
      danmakuPrimed = true;
      return;
    }
    var fresh = all.filter(function (b) {
      return b.approved && !danmakuSentIds[b.id];
    }).reverse();  // all 是倒序的，按时间正序发出

    fresh.slice(0, 4).forEach(function (b, i) {
      danmakuSentIds[b.id] = true;
      setTimeout(function () { shootDanmaku(b); }, i * 350);
    });
  }

  var danmakuPrimed = false;
  var danmakuSentIds = {};

  /* ==================== 弹幕 ==================== */

  function shootDanmaku(blessing) {
    if (!danmakuOn) return;
    var layer = $('danmakuLayer');
    var el = document.createElement('div');
    el.className = 'danmaku-item';
    el.innerHTML = UI.avatarHTML(blessing.avatar) +
      '<span class="dn-name">' + UI.escapeHtml(blessing.name) + '：</span>' +
      '<span>' + UI.escapeHtml(blessing.text) + '</span>';
    layer.appendChild(el);

    // 轨道分配：避开同一轨道上尚未走远的弹幕
    var trackCount = Math.max(4, Math.floor((window.innerHeight - 220) / TRACK_HEIGHT));
    if (!danmakuTracks.length) {
      danmakuTracks = new Array(trackCount).fill(0);
    }
    var now = Date.now();
    var track = 0;
    for (var i = 0; i < trackCount; i++) {
      if ((danmakuTracks[i] || 0) <= now) { track = i; break; }
      if (i === trackCount - 1) track = Math.floor(Math.random() * trackCount);
    }

    var w = el.offsetWidth || 200;
    var duration = Math.max(9000, Math.min(20000, (window.innerWidth + w) / 0.12));
    danmakuTracks[track] = now + duration * 0.55;

    el.style.top = (90 + track * TRACK_HEIGHT) + 'px';
    el.style.left = window.innerWidth + 'px';

    var anim = el.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-' + (window.innerWidth + w + 40) + 'px)' }
      ],
      { duration: duration, easing: 'linear' }
    );
    anim.onfinish = function () { el.remove(); };
  }

  /* ==================== 抽奖 ==================== */

  function renderPrizeTabs(s) {
    var tabs = $('prizeTabs');
    if (!currentPrizeId && s.config.prizes.length) {
      currentPrizeId = s.config.prizes[0].id;
    }

    // 脏检查：摇一摇期间每秒有多次状态更新，若不拦截，
    // 正在被点击的奖项按钮会被 innerHTML 重建掉，导致点击丢失。
    var key = s.config.prizes.map(function (p) {
      return p.id + ':' + p.name + ':' + p.count;
    }).join('|') + '#' + s.winners.length + '#' + s.guests.length + '#' + currentPrizeId;
    if (key === prizeTabsKey) return;
    prizeTabsKey = key;

    tabs.innerHTML = s.config.prizes.map(function (p) {
      var remain = poolSize(s, p.id);
      return '<button class="prize-tab' + (p.id === currentPrizeId ? ' active' : '') +
        '" data-prize="' + p.id + '">' + UI.escapeHtml(p.name) +
        '<span class="left">剩 ' + remain + '</span></button>';
    }).join('');

    var cur = s.config.prizes.filter(function (p) { return p.id === currentPrizeId; })[0];
    if (cur) {
      $('prizeName').textContent = cur.name;
      $('prizeSub').textContent = '本轮 ' + cur.count + ' 位 · 签到池 ' +
        s.guests.length + ' 人 · 已中奖 ' + s.winners.length + ' 人';
    }
  }

  function poolSize(s, prizeId) {
    var used = {};
    s.winners.forEach(function (w) { used[w.guestId] = true; });
    return s.guests.filter(function (g) { return !used[g.id]; }).length;
  }

  function renderWinners(s) {
    var strip = $('winnersStrip');
    var key = s.winners.length + ':' +
      (s.winners.length ? s.winners[s.winners.length - 1].id : '');
    if (key === winnersKey) return;
    winnersKey = key;

    if (!s.winners.length) {
      strip.innerHTML = '<span style="color:rgba(255,248,240,.35);font-size:.9rem">暂无中奖记录</span>';
      return;
    }
    strip.innerHTML = s.winners.slice().reverse().map(function (w) {
      return '<span class="winner-chip">' + UI.avatarHTML(w.avatar) +
        UI.escapeHtml(w.name) +
        '<span style="opacity:.65;font-size:.78rem">' + UI.escapeHtml(w.prize) + '</span></span>';
    }).join('');
  }

  var rollPool = [];

  /**
   * 抽奖控制同步（P0-4）：rolling 与 prizeId 的「真相」在共享 state.lottery 里，
   * 大屏本地按钮和主持控台手机都只是改 state，这里负责把状态落到 UI。
   */
  function syncLotteryControl(s) {
    var wantRolling = !!(s.lottery && s.lottery.rolling);
    var wantPrize = (s.lottery && s.lottery.prizeId) || currentPrizeId;

    if (wantPrize !== currentPrizeId) {
      currentPrizeId = wantPrize;
      prizeTabsKey = ''; // 强制 tab 重绘
      if (!wantRolling) $('rollBoard').innerHTML = '';
    }

    $('btnDraw').textContent = wantRolling ? '停止' : '开始抽奖';
    $('btnDraw').classList.toggle('btn-gold', !wantRolling);
    $('btnDraw').classList.toggle('btn-rose', wantRolling);

    if (wantRolling !== rolling) {
      rolling = wantRolling;
      if (rolling) startRoll();
      else stopRoll();
    }
  }

  function startRoll() {
    var s = store.getState();
    var prize = s.config.prizes.filter(function (p) { return p.id === currentPrizeId; })[0];
    if (!prize) {
      UI.toast('请先在设置里配置奖项');
      A.setLotteryRolling(store, false); // 回滚状态，避免卡在"滚动中"
      return;
    }

    var used = {};
    s.winners.forEach(function (w) { used[w.guestId] = true; });
    rollPool = s.guests.filter(function (g) { return !used[g.id]; });

    if (!rollPool.length) {
      UI.toast('没有可抽取的宾客，请检查签到情况');
      A.setLotteryRolling(store, false);
      return;
    }

    var slots = Math.min(prize.count, rollPool.length);
    var board = $('rollBoard');
    board.innerHTML = '';
    rollSlots = [];
    for (var i = 0; i < slots; i++) {
      var el = document.createElement('div');
      el.className = 'roll-slot rolling';
      el.innerHTML = '<div class="nm">???</div>';
      board.appendChild(el);
      rollSlots.push(el);
    }

    rollTimer = setInterval(function () {
      rollSlots.forEach(function (el) {
        var g = rollPool[Math.floor(Math.random() * rollPool.length)];
        el.innerHTML = UI.avatarHTML(g.avatar) +
          '<div class="nm">' + UI.escapeHtml(g.name) + '</div>';
      });
    }, 70);
  }

  function stopRoll() {
    // 用 rollTimer 判断是否真的在滚动：状态回滚路径（rolling 已为 false）不能误触 draw
    if (!rollTimer) return;
    clearInterval(rollTimer);
    rollTimer = null;

    var winners = A.draw(store, currentPrizeId);

    rollSlots.forEach(function (el, i) {
      el.classList.remove('rolling');
      var w = winners[i];
      if (w) {
        el.classList.add('won');
        el.innerHTML = UI.avatarHTML(w.avatar) +
          '<div class="nm">' + UI.escapeHtml(w.name) + '</div>';
      } else {
        el.innerHTML = '<div class="nm">—</div>';
      }
    });

    if (winners.length) {
      UI.toast('恭喜 ' + winners.map(function (w) { return w.name; }).join('、') + '！', 4000);
      // 中奖后弹一条祝贺弹幕
      winners.forEach(function (w, i) {
        setTimeout(function () {
          shootDanmaku({ avatar: w.avatar, name: w.prize + ' 🎉', text: '恭喜 ' + w.name + ' 中奖！' });
        }, i * 400);
      });
    }
  }

  function bindLottery() {
    // 大屏按钮只改共享 state，实际滚动由 syncLotteryControl 驱动；
    // 这样主持控台手机改同一 state 也能遥控大屏
    $('btnDraw').addEventListener('click', function () {
      var s = store.getState();
      A.setLotteryRolling(store, !(s.lottery && s.lottery.rolling));
    });

    $('btnRedraw').addEventListener('click', function () {
      if (rolling) return;
      if (!currentPrizeId) return;
      A.clearWinners(store, currentPrizeId);
      A.setLotteryRolling(store, false);
      $('rollBoard').innerHTML = '';
      UI.toast('已清空本轮中奖记录');
    });

    $('prizeTabs').addEventListener('click', function (e) {
      var tab = e.target.closest('.prize-tab');
      if (!tab || rolling) return;
      A.setLotteryPrize(store, tab.getAttribute('data-prize'));
    });
  }

  /* ==================== 摇一摇游戏 ==================== */

  function renderGame(s) {
    var g = s.game;
    var track = $('raceTrack');
    var cdEl = $('gameCountdown');
    var timerEl = $('gameTimer');

    if (g.state === 'countdown') {
      cdEl.classList.remove('hidden');
      timerEl.classList.add('hidden');
      track.classList.add('hidden');
      $('gameEmpty').classList.add('hidden');
      $('btnStartGame').textContent = '准备中…';
      $('btnStartGame').disabled = true;
      return;
    }

    if (g.state === 'running') {
      cdEl.classList.add('hidden');
      timerEl.classList.remove('hidden');
      track.classList.remove('hidden');
      $('gameEmpty').classList.add('hidden');
      $('btnStartGame').textContent = '进行中…';
      $('btnStartGame').disabled = true;
    } else if (g.state === 'finished') {
      cdEl.classList.add('hidden');
      timerEl.classList.add('hidden');
      track.classList.remove('hidden');
      $('gameEmpty').classList.add('hidden');
      $('btnStartGame').textContent = '再来一局';
      $('btnStartGame').disabled = false;
      $('gameTitle').textContent = '🏆 本轮结果';
    } else {
      cdEl.classList.add('hidden');
      timerEl.classList.add('hidden');
      track.classList.add('hidden');
      track.innerHTML = '';
      raceRows = {};
      $('gameEmpty').classList.remove('hidden');
      $('btnStartGame').textContent = '开始游戏';
      $('btnStartGame').disabled = false;
      $('gameTitle').textContent = '摇一摇 · 默契大比拼';
      return;
    }

    // 排名渲染：增量更新节点，避免每帧重建 DOM 打断进度条的 transition 动画
    var entries = Object.keys(g.scores).map(function (id) {
      return { id: id, score: g.scores[id] };
    }).sort(function (a, b) { return b.score - a.score; }).slice(0, 10);

    if (!entries.length) {
      if (!track.querySelector('.race-empty')) {
        track.innerHTML = '<div class="race-empty game-empty">等待宾客摇动手机…</div>';
      }
      raceRows = {};
      return;
    }
    var hint = track.querySelector('.race-empty');
    if (hint) hint.remove();

    var guests = {};
    s.guests.forEach(function (x) { guests[x.id] = x; });

    var maxScore = entries[0].score || 1;

    entries.forEach(function (e, i) {
      var row = raceRows[e.id];
      if (!row) {
        row = document.createElement('div');
        row.className = 'race-row';
        row.innerHTML = '<div class="race-rank"></div>' +
          '<div class="race-avatar"></div>' +
          '<div class="race-bar-wrap">' +
            '<span class="race-name"></span>' +
            '<div class="race-bar"><span class="race-score"></span></div>' +
          '</div>';
        track.appendChild(row);
        raceRows[e.id] = row;

        var gst = guests[e.id] || { name: '未知', avatar: '' };
        row.querySelector('.race-avatar').innerHTML =
          gst.avatar && gst.avatar.length > 12
            ? '<img src="' + gst.avatar + '" alt="">'
            : (gst.avatar || '🌹');
        row.querySelector('.race-name').textContent = gst.name;
      }
      // 用 order 调整名次，DOM 节点不变，进度条动画得以保留
      row.style.order = i;
      var rank = row.querySelector('.race-rank');
      rank.textContent = i + 1;
      rank.className = 'race-rank' +
        (i === 0 ? ' top1' : (i === 1 ? ' top2' : (i === 2 ? ' top3' : '')));
      row.querySelector('.race-bar').style.width =
        Math.max(8, Math.round((e.score / maxScore) * 100)) + '%';
      row.querySelector('.race-score').textContent = e.score;
    });

    // 掉出前十的行移除
    var topIds = {};
    entries.forEach(function (e) { topIds[e.id] = true; });
    Object.keys(raceRows).forEach(function (id) {
      if (!topIds[id]) {
        raceRows[id].remove();
        delete raceRows[id];
      }
    });
  }

  var lastCdText = '';

  function tickGame() {
    var s = store.getState();
    var g = s.game;

    if (g.state === 'countdown') {
      var left = Math.ceil((g.startAt - Date.now()) / 1000);
      var txt = left > 0 ? String(left) : 'GO!';
      if (txt !== lastCdText) {
        lastCdText = txt;
        var cd = $('gameCountdown');
        if (cd) {
          cd.textContent = txt;
          cd.style.animation = 'none';
          void cd.offsetWidth;
          cd.style.animation = '';
        }
      }
      if (isController && Date.now() >= g.startAt) {
        A.runGame(store);
      }
      return;
    }

    if (g.state === 'running') {
      var remain = g.duration - (Date.now() - g.startAt) / 1000;
      var el = $('gameTimer');
      if (el) el.textContent = (remain > 0 ? remain : 0).toFixed(1);
      if (isController && remain <= 0) {
        A.finishGame(store);
      }
    }
  }

  function bindGame() {
    $('btnStartGame').addEventListener('click', function () {
      A.startGame(store, 30);
      $('gameTitle').textContent = '摇一摇 · 默契大比拼';
      lastCdText = '';
    });
    $('btnResetGame').addEventListener('click', function () {
      A.resetGame(store);
      $('gameTitle').textContent = '摇一摇 · 默契大比拼';
    });
  }

  /* ==================== 舞台切换 ==================== */

  function switchStage(stage) {
    currentStage = stage;
    ['wall', 'lottery', 'game'].forEach(function (k) {
      $('panel' + k.charAt(0).toUpperCase() + k.slice(1))
        .classList.toggle('active', k === stage);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.stage-tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-stage') === stage);
    });
    A.setStage(store, stage);
    if (stage === 'wall') {
      // 切回签到墙时重新布局，此时容器已有尺寸
      setTimeout(function () {
        Object.keys(wallNodes).forEach(function (id) { delete wallNodes[id]; });
        $('wallCanvas').innerHTML = '<div class="wall-empty hidden" id="wallEmpty">' +
          '<div class="big">💒</div><p>等待宾客扫码签到</p></div>';
        renderWall(store.getState(), true);
      }, 50);
    }
  }

  function bindConsole() {
    $('consoleBar').addEventListener('click', function (e) {
      var tab = e.target.closest('.stage-tab');
      if (tab) switchStage(tab.getAttribute('data-stage'));
    });
  }

  /* ==================== 顶栏 ==================== */

  function bindTopbar() {
    $('btnFullscreen').addEventListener('click', function () {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function () {
          UI.toast('浏览器拒绝了全屏请求，请手动按 F11');
        });
      } else {
        document.exitFullscreen();
      }
    });

    $('btnDanmaku').addEventListener('click', function () {
      // 走共享 state，主持控台与设置面板看到同一开关
      var s = store.getState();
      var next = !(s.config && s.config.danmaku === false);
      A.updateConfig(store, { danmaku: next });
      UI.toast(next ? '弹幕已开启' : '弹幕已关闭');
    });

    $('btnSettings').addEventListener('click', openSettings);
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '1') switchStage('wall');
      else if (e.key === '2') switchStage('lottery');
      else if (e.key === '3') switchStage('game');
      else if (e.code === 'Space') {
        e.preventDefault();
        if (currentStage === 'lottery') {
          var s = store.getState();
          A.setLotteryRolling(store, !(s.lottery && s.lottery.rolling));
        } else if (currentStage === 'game') {
          $('btnStartGame').click();
        }
      } else if (e.key === 'Escape') {
        closeSettings();
      }
    });
  }

  /* ==================== 设置 ==================== */

  function openSettings() {
    var s = store.getState();
    $('cfgGroom').value = s.config.groom || '';
    $('cfgBride').value = s.config.bride || '';
    $('cfgSub').value = s.config.date || '';
    $('swReview').classList.toggle('on', !!s.config.needReview);
    $('swDanmaku').classList.toggle('on', !(s.config && s.config.danmaku === false));
    $('cfgPasscode').value = s.config.passcode || '';

    // 视觉与音乐：编辑期用 pending 副本，保存时才写入共享 state
    var p = s.config.photos || {};
    pendingPhotos = { bg: p.bg || '', couple: p.couple || '', logo: p.logo || '' };
    pendingMusic = s.config.music || '';
    renderPhotoThumbs();
    $('musicName').textContent = pendingMusic ? '已选音乐（保存后生效）' : '';
    $('musicTip').textContent = isWsMode
      ? '上传后循环播放，可在顶栏 🎵 控制'
      : '⚠ 背景音乐需要「服务器模式」：双击 deploy.bat 后用局域网地址打开大屏';

    renderPrizeEditor(s.config.prizes);
    $('settingsModal').classList.remove('hidden');
  }

  function renderPhotoThumbs() {
    [['bg', 'thumbBg'], ['couple', 'thumbCouple'], ['logo', 'thumbLogo']].forEach(function (pair) {
      var key = pair[0];
      var el = $(pair[1]);
      if (!el) return;
      var v = pendingPhotos[key];
      el.classList.toggle('has-img', !!v);
      el.style.backgroundImage = v ? 'url("' + v + '")' : '';
      el.innerHTML = v ? '' : (key === 'bg' ? '背景图' : (key === 'couple' ? '合照' : 'Logo'));
    });
  }

  function closeSettings() {
    $('settingsModal').classList.add('hidden');
  }

  function renderPrizeEditor(prizes) {
    $('prizeEditor').innerHTML = prizes.map(function (p, i) {
      return '<div class="prize-edit-row" data-idx="' + i + '">' +
        '<input type="text" class="pz-name" value="' + UI.escapeHtml(p.name) + '" placeholder="奖项名">' +
        '<input type="number" class="pz-count" min="1" max="99" value="' + p.count + '">' +
        '<button class="prize-del" data-del="' + i + '" title="删除">×</button>' +
      '</div>';
    }).join('');
  }

  function bindSettings() {
    $('btnCloseSettings').addEventListener('click', closeSettings);
    $('settingsModal').addEventListener('click', function (e) {
      if (e.target === $('settingsModal')) closeSettings();
    });

    $('swReview').addEventListener('click', function () {
      this.classList.toggle('on');
    });
    $('swDanmaku').addEventListener('click', function () {
      this.classList.toggle('on');
    });

    $('btnAddPrize').addEventListener('click', function () {
      var rows = [].slice.call(document.querySelectorAll('#prizeEditor .prize-edit-row'));
      var prizes = rows.map(function (r) {
        return {
          name: r.querySelector('.pz-name').value,
          count: parseInt(r.querySelector('.pz-count').value, 10) || 1
        };
      });
      prizes.push({ name: '幸运奖', count: 3 });
      renderPrizeEditor(prizes);
    });

    $('prizeEditor').addEventListener('click', function (e) {
      var del = e.target.getAttribute && e.target.getAttribute('data-del');
      if (del == null) return;
      var rows = [].slice.call(document.querySelectorAll('#prizeEditor .prize-edit-row'));
      var prizes = rows.map(function (r) {
        return {
          name: r.querySelector('.pz-name').value,
          count: parseInt(r.querySelector('.pz-count').value, 10) || 1
        };
      });
      prizes.splice(parseInt(del, 10), 1);
      renderPrizeEditor(prizes);
    });

    $('btnSaveSettings').addEventListener('click', function () {
      var rows = [].slice.call(document.querySelectorAll('#prizeEditor .prize-edit-row'));
      var prizes = rows.map(function (r, i) {
        return {
          id: (store.getState().config.prizes[i] || {}).id || ('p' + Date.now() + '_' + i),
          name: (r.querySelector('.pz-name').value || '奖项').trim(),
          count: Math.max(1, parseInt(r.querySelector('.pz-count').value, 10) || 1)
        };
      });
      if (!prizes.length) prizes = [{ id: 'p1', name: '幸运奖', count: 1 }];

      A.updateConfig(store, {
        groom: ($('cfgGroom').value || '新郎').trim(),
        bride: ($('cfgBride').value || '新娘').trim(),
        date: ($('cfgSub').value || '').trim(),
        needReview: $('swReview').classList.contains('on'),
        danmaku: $('swDanmaku').classList.contains('on'),
        passcode: ($('cfgPasscode').value || '').replace(/[^\d]/g, '').slice(0, 4),
        photos: pendingPhotos,
        music: pendingMusic,
        prizes: prizes
      });

      if (!prizes.filter(function (p) { return p.id === currentPrizeId; }).length) {
        currentPrizeId = prizes[0].id;
      }
      closeSettings();
      UI.toast('设置已保存');
    });

    $('btnClearWinners').addEventListener('click', function () {
      if (!confirm('确定清空所有中奖记录？已中奖的宾客将可被重新抽取。')) return;
      guardPasscode(function () {
        A.clearWinners(store, null);
        UI.toast('中奖记录已清空');
      });
    });

    $('btnClearBlessings').addEventListener('click', function () {
      if (!confirm('确定清空所有祝福？此操作不可恢复。')) return;
      guardPasscode(function () {
        store.update(function (s) { s.blessings = []; });
        lastBlessingCount = 0;
        UI.toast('祝福已清空');
      });
    });

    $('btnResetAll').addEventListener('click', function () {
      if (!confirm('确定重置全部数据？签到、祝福、中奖记录都会被清空。')) return;
      guardPasscode(function () {
        store.reset();
        lastBlessingCount = 0;
        closeSettings();
        UI.toast('已重置');
      });
    });

    // 祝福审核
    $('blessList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      var act = btn.getAttribute('data-act');
      if (act === 'approve') {
        A.approveBlessing(store, id, true);
        lastBlessingCount = 0; // 强制重绘
      } else {
        A.removeBlessing(store, id);
        lastBlessingCount = 0;
      }
    });

    bindVisualUploads();
    bindMusicToggle();
    bindExports();
  }

  /* ==================== 视觉与音乐上传（M2-1 / M2-2） ==================== */

  /** 现场口令守卫（P1-4）：启用口令后，危险操作需验证 */
  function guardPasscode(cb) {
    var code = (store.getState().config || {}).passcode;
    if (code) {
      UI.askPasscode(code, function (ok) { if (ok) cb(); }, '危险操作需口令');
    } else {
      cb();
    }
  }

  function bindVisualUploads() {
    var photoKeys = { fileBg: 'bg', fileCouple: 'couple', fileLogo: 'logo' };
    Object.keys(photoKeys).forEach(function (fileId) {
      var key = photoKeys[fileId];
      $(fileId).addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        UI.toast('正在处理图片…');
        UI.compressImage(file, 1200, function (dataUrl, err) {
          if (err) { UI.toast('图片处理失败：' + err); return; }
          uploadResource(dataUrl).then(function (finalUrl) {
            pendingPhotos[key] = finalUrl;
            renderPhotoThumbs();
            UI.toast('已选' + (key === 'bg' ? '背景图' : (key === 'couple' ? '合照' : 'Logo')) + '，保存后生效');
          });
        });
        e.target.value = '';
      });
    });

    [['delBg', 'bg'], ['delCouple', 'couple'], ['delLogo', 'logo']].forEach(function (pair) {
      $(pair[0]).addEventListener('click', function () {
        pendingPhotos[pair[1]] = '';
        renderPhotoThumbs();
      });
    });

    // 背景音乐
    $('fileMusic').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!/^audio\//.test(file.type)) { UI.toast('请选择音频文件（MP3 等）'); return; }
      if (!isWsMode) {
        UI.toast('背景音乐需要服务器模式：先用 deploy.bat 启动服务');
        return;
      }
      UI.toast('正在上传音乐（大文件稍等）…');
      var reader = new FileReader();
      reader.onload = function (ev) {
        uploadResource(ev.target.result).then(function (finalUrl) {
          pendingMusic = finalUrl;
          $('musicName').textContent = '已选音乐（保存后生效）';
          UI.toast('音乐已上传，保存后生效');
        });
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });

    $('delMusic').addEventListener('click', function () {
      pendingMusic = '';
      $('musicName').textContent = '';
    });
  }

  function bindMusicToggle() {
    $('btnMusic').addEventListener('click', function () {
      var s = store.getState();
      var src = s.config.music;
      if (!src) { UI.toast('请先在 ⚙ 设置里上传背景音乐'); return; }
      if (!audioEl) syncMusic(s);
      if (!audioEl) return;
      if (audioEl.paused) {
        audioEl.play().then(function () {
          musicPlaying = true;
          $('btnMusic').textContent = '⏸';
        }).catch(function () {
          UI.toast('浏览器阻止了自动播放，请再点一次');
        });
      } else {
        audioEl.pause();
        musicPlaying = false;
        $('btnMusic').textContent = '🎵';
      }
    });
  }

  /* ==================== 数据导出（M2-3） ==================== */

  function bindExports() {
    $('btnExportJson').addEventListener('click', function () {
      var s = store.getState();
      var blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'wedding-data-' + Date.now() + '.json');
      UI.toast('JSON 已导出');
    });

    $('btnExportWall').addEventListener('click', function () {
      var s = store.getState();
      var approved = s.blessings.filter(function (b) { return b.approved; });
      if (!approved.length) { UI.toast('还没有上墙的祝福'); return; }
      buildBlessingWallImage(s, approved);
    });
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }

  /**
   * 祝福纪念长图：canvas 绘制，每张卡片一条祝福，导出 PNG（适合发朋友圈/打印）。
   */
  function buildBlessingWallImage(s, blessings) {
    UI.toast('正在生成祝福长图…');
    var W = 1080;
    var cardH = 132;
    var headerH = 300;
    var pad = 56;
    var H = headerH + blessings.length * cardH + pad * 2;

    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');

    // 背景渐变
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#4a1523');
    grad.addColorStop(1, '#2e0b13');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 顶部标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f3dda1';
    ctx.font = 'bold 54px "Songti SC", "SimSun", serif';
    ctx.fillText((s.config.groom || '新郎') + ' ♥ ' + (s.config.bride || '新娘'), W / 2, 120);
    ctx.font = '28px sans-serif';
    ctx.fillStyle = 'rgba(255,248,240,.75)';
    ctx.fillText('大家的祝福 · ' + blessings.length + ' 条', W / 2, 176);
    ctx.fillText('『 ' + (s.config.date || '婚礼现场') + ' 』', W / 2, 226);

    // 每条祝福卡片
    ctx.textAlign = 'left';
    blessings.forEach(function (b, i) {
      var y = headerH + i * cardH + pad * 0.4;
      // 卡片背景
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      roundRect(ctx, pad, y, W - pad * 2, cardH - 16, 16);
      ctx.fill();
      // 名字
      ctx.fillStyle = '#f3dda1';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText(b.name || '匿名宾客', pad + 30, y + 46);
      // 祝福内容
      ctx.fillStyle = '#fff8f0';
      ctx.font = '30px sans-serif';
      wrapText(ctx, b.text, pad + 30, y + 92, W - pad * 2 - 60, 38);
    });

    // 尾部
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,248,240,.5)';
    ctx.font = '24px sans-serif';
    ctx.fillText('—— 由 wedding-live 现场互动系统生成 ——', W / 2, H - 28);

    canvas.toBlob(function (blob) {
      if (!blob) { UI.toast('长图生成失败'); return; }
      downloadBlob(blob, 'blessing-wall-' + Date.now() + '.png');
      UI.toast('祝福长图已导出');
    }, 'image/png');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 简单多行文本绘制 */
  function wrapText(ctx, text, x, y, maxW, lineH) {
    var chars = String(text).split('');
    var line = '';
    var yy = y;
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxW) {
        ctx.fillText(line, x, yy);
        line = chars[i];
        yy += lineH;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, yy);
  }

  /* ==================== 自适应 ==================== */

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (currentStage === 'wall') {
        renderWall(store.getState(), true);
      }
    }, 200);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
