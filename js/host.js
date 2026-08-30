/**
 * host.js —— 主持手机控台（P0-4）
 *
 * 与 mobile.html 一样走 RemoteStore + WebSocket，但只做「控制」不做签到：
 *   - 切换大屏舞台（state.stage）
 *   - 抽奖：选奖项 / 开始·停止滚动 / 重抽（state.lottery）
 *   - 摇一摇：开始 / 重置（state.game）
 *   - 弹幕开关（state.config.danmaku）
 * 大屏端通过订阅同样的 state 自动跟随，无需任何新协议。
 *
 * 必须通过 ?ws= 地址访问，例如：
 *   host.html?ws=ws://192.168.1.100:8080
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var wsUrl = params.get('ws');

  if (!wsUrl) {
    document.body.innerHTML =
      '<div style="padding:2.5rem 1.5rem;text-align:center;color:#a33;font-family:sans-serif;line-height:2">' +
      '主持控台必须带 <b>?ws=</b> 参数访问<br>' +
      '示例：<code>host.html?ws=ws://192.168.1.100:8080</code></div>';
    return;
  }
  if (typeof WeddingRemoteStore === 'undefined') {
    document.body.innerHTML =
      '<div style="padding:2.5rem;text-align:center;color:#a33">remote-store.js 未加载，请检查脚本引用</div>';
    return;
  }

  var store = new WeddingRemoteStore(wsUrl);
  var A = WeddingStore.Actions;
  var UI = window.UI;
  var $ = function (id) { return document.getElementById(id); };

  var lastPrizeKey = '';

  function render() {
    var s = store.getState();
    if (!s || !s.config) return;

    $('hdNames').textContent =
      (s.config.groom || '新郎') + ' ♥ ' + (s.config.bride || '新娘') + ' · 主持控台';

    $('stGuests').textContent = s.guests.length;
    $('stBless').textContent = s.blessings.filter(function (b) { return b.approved; }).length;
    $('stWinners').textContent = s.winners.length;

    var pending = s.blessings.filter(function (b) { return !b.approved; }).length;
    $('stPending').textContent = pending;
    $('pendingTip').classList.toggle('show', pending > 0);

    // 舞台高亮
    Array.prototype.forEach.call(document.querySelectorAll('.h-btn[data-stage]'), function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-stage') === s.stage);
    });

    renderPrizeBtns(s);

    // 抽奖主按钮
    var rolling = !!(s.lottery && s.lottery.rolling);
    var drawBtn = $('btnDrawToggle');
    drawBtn.textContent = rolling ? '■ 停止滚动' : '开始滚动';
    drawBtn.classList.toggle('gold', !rolling);
    drawBtn.classList.toggle('primary', rolling);

    // 游戏状态
    var gs = $('gameState');
    var g = s.game || {};
    if (g.state === 'countdown') {
      var cd = Math.max(0, Math.ceil(((g.startAt || 0) - Date.now()) / 1000));
      gs.textContent = '准备开始… ' + (cd > 0 ? cd : 'GO!');
      gs.classList.add('live');
    } else if (g.state === 'running') {
      var remain = Math.max(0, g.duration - (Date.now() - g.startAt) / 1000);
      gs.textContent = '进行中！剩余 ' + remain.toFixed(1) + ' 秒';
      gs.classList.add('live');
    } else if (g.state === 'finished') {
      gs.textContent = '本轮已结束';
      gs.classList.remove('live');
    } else {
      gs.textContent = '游戏未开始';
      gs.classList.remove('live');
    }

    // 弹幕
    $('btnDanmaku').textContent = '弹幕：' + (s.config.danmaku !== false ? '开' : '关');
  }

  function renderPrizeBtns(s) {
    var prizes = s.config.prizes || [];
    var sel = (s.lottery && s.lottery.prizeId) ||
      (prizes.length ? prizes[0].id : null);
    var key = prizes.map(function (p) {
      return p.id + ':' + p.name + ':' + p.count;
    }).join('|') + '#' + sel;
    if (key === lastPrizeKey) return;
    lastPrizeKey = key;

    $('prizeBtns').innerHTML = prizes.map(function (p) {
      return '<button class="h-btn' + (p.id === sel ? ' gold active' : '') +
        '" data-prize="' + p.id + '">' +
        UI.escapeHtml(p.name) + '（' + p.count + ' 名）</button>';
    }).join('');
  }

  function bind() {
    // 舞台切换
    document.querySelectorAll('.h-btn[data-stage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        A.setStage(store, btn.getAttribute('data-stage'));
      });
    });

    // 抽奖奖项
    $('prizeBtns').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-prize]');
      if (!btn) return;
      A.setLotteryPrize(store, btn.getAttribute('data-prize'));
    });

    // 开始/停止滚动
    $('btnDrawToggle').addEventListener('click', function () {
      var s = store.getState();
      A.setLotteryRolling(store, !(s.lottery && s.lottery.rolling));
    });

    // 重抽本轮
    $('btnRedraw').addEventListener('click', function () {
      var s = store.getState();
      var prizeId = (s.lottery && s.lottery.prizeId) ||
        ((s.config.prizes[0] || {}).id || null);
      if (!prizeId) { UI.toast('尚未配置奖项'); return; }
      A.setLotteryRolling(store, false);
      A.clearWinners(store, prizeId);
      UI.toast('已清空该奖项中奖记录');
    });

    // 游戏
    $('btnGameStart').addEventListener('click', function () {
      A.startGame(store, 30);
      UI.toast('游戏已开始，大屏进入倒计时');
    });
    $('btnGameReset').addEventListener('click', function () {
      A.resetGame(store);
      UI.toast('已重置游戏');
    });

    // 弹幕
    $('btnDanmaku').addEventListener('click', function () {
      var s = store.getState();
      var next = !(s.config && s.config.danmaku !== false);
      A.updateConfig(store, { danmaku: next });
      UI.toast(next ? '弹幕已开启' : '弹幕已关闭');
    });
  }

  bind();
  store.subscribe(function () { render(); });
  render();

  // 倒计时/进行中的剩余秒数需要持续刷新
  setInterval(function () {
    var s = store.getState();
    if (!s) return;
    var st = s.game && s.game.state;
    if (st === 'running' || st === 'countdown') render();
  }, 200);
})();
