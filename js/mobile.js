/**
 * mobile.js —— 手机端（宾客侧）逻辑
 *
 * 流程：先签到进入抽奖池 → 之后可送祝福 / 参与摇一摇。
 * 身份存在本机 localStorage，刷新或锁屏后自动恢复。
 *
 * 摇一摇的双通道设计：
 *   优先用陀螺仪；但 iOS Safari 在非 HTTPS 下不提供 devicemotion（局域网常见的
 *   http://192.168.x.x 就是这种场景），因此点击大圆加分的兜底通道始终可用，
 *   保证任何设备都能玩。两条通道共用同一节流与计分逻辑。
 */
(function () {
  'use strict';

  // 根据 URL 上的 ?ws= 参数决定用 LocalStore 还是 RemoteStore
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

  var MY_KEY = 'wedding_my_guest';
  var me = null;               // { id, name, avatar }
  var selectedAvatar = null;
  var avatarPage = 0;
  var isWsMode = !!(new URLSearchParams(location.search).get('ws'));

  /**
   * base64 头像外置上传（P0-1）。
   * ws 模式下把 base64 图片 POST 到服务端落盘，state 里只存 URL，
   * 200 位宾客的 state 由此从 ~1MB 降到 ~20KB。
   * 上传失败时降级回 base64，保证签到永不因头像失败而阻塞。
   */
  function ensureAvatarUploaded(avatar) {
    return new Promise(function (resolve) {
      if (!avatar || avatar.length <= 12) { resolve(avatar); return; } // emoji 直接过
      if (!isWsMode) { resolve(avatar); return; }                      // 单机模式保持 base64
      fetch(location.origin + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: avatar })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        resolve(j.url || avatar);
      }).catch(function () {
        resolve(avatar); // 降级
      });
    });
  }

  var QUICK_BLESSINGS = [
    '新婚快乐，百年好合！',
    '愿你们永远幸福甜蜜！',
    '一生一世一双人',
    '甜甜蜜蜜，白头偕老',
    '恭喜恭喜，早生贵子！',
    '祝你们永远像今天一样幸福',
    '缘定三生，情比金坚',
    '愿有岁月可回首，且以深情共白头'
  ];

  /* ==================== 身份 ==================== */

  function loadMe() {
    try {
      var raw = localStorage.getItem(MY_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.id) return null;
      // 大屏端清空数据后，本地身份会失效，需要重新签到
      var exists = store.getState().guests.some(function (g) { return g.id === obj.id; });
      if (!exists) {
        localStorage.removeItem(MY_KEY);
        return null;
      }
      return obj;
    } catch (e) {
      return null;
    }
  }

  function saveMe(obj) {
    me = obj;
    try { localStorage.setItem(MY_KEY, JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
  }

  /* ==================== 初始化 ==================== */

  function init() {
    renderAvatarGrid();
    renderQuickList();
    bindSignin();
    bindBless();
    bindGame();
    bindMe();
    bindTabs();

    me = loadMe();
    if (me) {
      enterMain();
    } else {
      $('pageSignin').classList.remove('hidden');
      $('pageMain').classList.add('hidden');
    }

    store.subscribe(function () {
      renderHeader();
      if (me) {
        renderMyBlessings();
        renderGameState();
        renderMe();
      }
    });

    renderHeader();

    if (location.protocol === 'file:') {
      UI.toast('请通过局域网地址访问（file:// 无法与大屏同步）', 6000);
    }
  }

  function renderHeader() {
    var s = store.getState();
    ['hdGroom', 'hdGroom2'].forEach(function (id) {
      if ($(id)) $(id).textContent = s.config.groom || '新郎';
    });
    ['hdBride', 'hdBride2'].forEach(function (id) {
      if ($(id)) $(id).textContent = s.config.bride || '新娘';
    });
    ['hdSub', 'hdSub2'].forEach(function (id) {
      if ($(id)) $(id).textContent = s.config.date || 'WEDDING PARTY';
    });
    if ($('totalGuests')) $('totalGuests').textContent = s.guests.length;
  }

  /* ==================== 签到 ==================== */

  function renderAvatarGrid() {
    var all = UI.PRESET_AVATARS;
    var perPage = 18;
    var start = (avatarPage * perPage) % all.length;
    var list = [];
    for (var i = 0; i < perPage; i++) list.push(all[(start + i) % all.length]);

    var grid = $('avatarGrid');
    grid.innerHTML = list.map(function (em, idx) {
      return '<button class="avatar-opt' + (selectedAvatar === em ? ' sel' : '') +
        '" data-emo="' + em + '">' + em + '</button>';
    }).join('');

    if (!selectedAvatar) {
      selectedAvatar = list[0];
      grid.firstChild && grid.firstChild.classList.add('sel');
    }
  }

  function bindSignin() {
    $('avatarGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('.avatar-opt');
      if (!btn) return;
      selectedAvatar = btn.getAttribute('data-emo');
      [].forEach.call(this.querySelectorAll('.avatar-opt'), function (el) {
        el.classList.toggle('sel', el === btn);
      });
    });

    $('btnRandomAvatar').addEventListener('click', function () {
      avatarPage++;
      renderAvatarGrid();
    });

    $('fileAvatar').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      UI.toast('正在处理图片…');
      UI.compressImage(file, 120, function (dataUrl, err) {
        if (err) { UI.toast('图片处理失败：' + err); return; }
        selectedAvatar = dataUrl;
        var grid = $('avatarGrid');
        // 把上传的头像放在首位并选中
        var first = grid.firstChild;
        if (first) {
          first.innerHTML = '<img src="' + dataUrl + '" alt="">';
          first.setAttribute('data-emo', dataUrl);
          [].forEach.call(grid.querySelectorAll('.avatar-opt'), function (el) {
            el.classList.toggle('sel', el === first);
          });
        }
        UI.toast('头像已更新');
      });
    });

    $('btnSignin').addEventListener('click', function () {
      var name = ($('inpName').value || '').trim();
      if (!name) { UI.toast('请先填写名字'); $('inpName').focus(); return; }
      if (name.length > 12) name = name.slice(0, 12);

      var btn = this;
      btn.disabled = true;
      var avatar = selectedAvatar || UI.randomAvatar();

      ensureAvatarUploaded(avatar).then(function (finalAvatar) {
        var guest = A.signIn(store, { name: name, avatar: finalAvatar });
        saveMe({ id: guest.id, name: guest.name, avatar: guest.avatar });
        btn.disabled = false;
        UI.toast('签到成功，欢迎 ' + name + '！');
        enterMain();
        setupMotionIfNeeded();
      });
    });

    $('inpName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btnSignin').click();
    });
  }

  function enterMain() {
    $('pageSignin').classList.add('hidden');
    $('pageMain').classList.remove('hidden');
    renderMyBlessings();
    renderGameState();
    renderMe();
    renderHeader();
    window.scrollTo(0, 0);
  }

  /* ==================== 祝福 ==================== */

  function renderQuickList() {
    $('quickList').innerHTML = QUICK_BLESSINGS.map(function (t) {
      return '<button class="quick-item">' + UI.escapeHtml(t) + '</button>';
    }).join('');
  }

  function bindBless() {
    $('quickList').addEventListener('click', function (e) {
      var item = e.target.closest('.quick-item');
      if (!item) return;
      var ta = $('inpBless');
      var txt = item.textContent;
      ta.value = ta.value ? (ta.value.replace(/[，。！,.!]\s*$/, '') + '，' + txt) : txt;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
    });

    $('inpBless').addEventListener('input', function () {
      $('blessLen').textContent = this.value.length;
    });

    $('btnSendBless').addEventListener('click', function () {
      if (!me) { UI.toast('请先签到'); return; }
      var text = ($('inpBless').value || '').trim();
      if (!text) { UI.toast('写点什么吧'); return; }
      if (text.length > 60) text = text.slice(0, 60);

      text = UI.filterText(text);
      A.addBlessing(store, {
        name: me.name,
        avatar: me.avatar,
        text: text
      });

      $('inpBless').value = '';
      $('blessLen').textContent = '0';

      var s = store.getState();
      $('blessTip').innerHTML = s.config.needReview
        ? '已提交，等待新人审核后上墙 🌸'
        : '已发送，快看大屏 💌';
      UI.toast(s.config.needReview ? '已提交，等待审核' : '祝福已送达大屏');
      setTimeout(function () { $('blessTip').innerHTML = ''; }, 4000);
    });
  }

  function renderMyBlessings() {
    if (!me) return;
    var s = store.getState();
    var mine = s.blessings.filter(function (b) { return b.name === me.name; }).reverse();
    var box = $('myBlessList');
    if (!mine.length) {
      box.innerHTML = '<div class="m-tip">还没有发送过祝福</div>';
      return;
    }
    box.innerHTML = mine.map(function (b) {
      return '<div class="my-bless-item">' + UI.escapeHtml(b.text) +
        '<div class="t">' + UI.formatTime(b.ts) +
        (b.approved ? ' · 已上墙' : ' · 等待审核') + '</div></div>';
    }).join('');
  }

  /* ==================== 摇一摇 ==================== */

  var motionEnabled = false;
  var lastShakeAt = 0;
  var lastAcc = null;
  var SHAKE_INTERVAL = 70;       // 两次有效摇动的最小间隔
  var SHAKE_THRESHOLD = 12;      // 三轴合成加速度变化阈值（m/s²）

  function gameIsRunning() {
    return store.getState().game.state === 'running';
  }

  /**
   * 计一次有效摇动。两条通道（陀螺仪 / 点击）都汇聚到这里，
   * 共用节流，避免手感不一致或刷分。
   */
  function doShake() {
    if (!me || !gameIsRunning()) return;
    var now = Date.now();
    if (now - lastShakeAt < SHAKE_INTERVAL) return;
    lastShakeAt = now;
    A.bumpScore(store, me.id, 1);
    $('myScore').textContent = store.getState().game.scores[me.id] || 0;
  }

  function onMotion(e) {
    var acc = e.accelerationIncludingGravity;
    if (!acc || acc.x == null) return;
    if (!lastAcc) { lastAcc = { x: acc.x, y: acc.y, z: acc.z }; return; }
    var dx = acc.x - lastAcc.x;
    var dy = acc.y - lastAcc.y;
    var dz = acc.z - lastAcc.z;
    lastAcc = { x: acc.x, y: acc.y, z: acc.z };
    var diff = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (diff > SHAKE_THRESHOLD) doShake();
  }

  /**
   * 尝试接入陀螺仪。
   * iOS 13+ 需要用户手势调用 requestPermission，且只在 HTTPS 下有效；
   * 局域网 http 场景拿不到权限，此时保留点击兜底并如实提示。
   */
  function setupMotion() {
    // 只执行一次：重复绑定 devicemotion 会让一次摇动被计两次分
    if (motionSetupDone) return;
    motionSetupDone = true;

    if (typeof DeviceMotionEvent === 'undefined') {
      $('shakeTip').innerHTML = '当前设备不支持重力感应<br>直接点击下方圆形按钮参与';
      return;
    }

    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      // iOS 13+：必须由用户手势触发
      $('shakeTip').innerHTML =
        '<button class="m-btn m-btn-ghost" id="btnMotionAuth" style="padding:.6rem;font-size:.88rem">' +
        '开启摇一摇感应</button>' +
        '<div style="margin-top:.5rem">若无法开启，直接点击上方圆形按钮同样有效</div>';
      $('btnMotionAuth').addEventListener('click', function () {
        DeviceMotionEvent.requestPermission().then(function (res) {
          if (res === 'granted') {
            window.addEventListener('devicemotion', onMotion);
            motionEnabled = true;
            $('shakeTip').innerHTML = '感应已开启，用力摇动手机吧！';
            UI.toast('摇一摇已开启');
          } else {
            $('shakeTip').innerHTML = '未获得感应权限<br>直接点击圆形按钮参与';
          }
        }).catch(function () {
          // 非安全上下文（http）会走到这里
          $('shakeTip').innerHTML = '当前网络环境不支持重力感应（需 HTTPS）<br>直接点击圆形按钮参与';
        });
      });
      return;
    }

    // Android / 桌面：直接监听
    window.addEventListener('devicemotion', onMotion);
    motionEnabled = true;
    $('shakeTip').innerHTML = motionEnabled
      ? '用力摇动手机，或直接点击圆形按钮'
      : '点击圆形按钮参与';
  }

  /**
   * 注意：这里刻意不使用全屏遮罩来显示倒计时。
   * 摇一摇的点击兜底通道依赖用户点击圆形区域，任何覆盖层都会挡住点击，
   * 在拿不到陀螺仪权限的 iOS 上会直接导致游戏无法参与。
   * 因此倒计时与剩余时间全部收敛在状态栏文字里。
   */
  function renderGameState() {
    if (!me) return;
    var s = store.getState();
    var g = s.game;
    var st = $('shakeStatus');
    var zone = document.querySelector('.shake-zone');

    $('myScore').textContent = g.scores[me.id] || 0;

    if (g.state === 'idle') {
      st.textContent = '等待主持人开始游戏';
      st.className = 'shake-status';
      if (zone) zone.classList.remove('live');
      $('rankHint').textContent = '';
      $('miniRank').innerHTML = '<div class="m-tip">游戏开始后显示排名</div>';
      rankKey = '';
      return;
    }

    if (g.state === 'countdown') {
      var left = Math.ceil((g.startAt - Date.now()) / 1000);
      st.textContent = left > 0 ? ('准备… ' + left) : '开始！';
      st.className = 'shake-status countdown';
      if (zone) zone.classList.add('live');
      $('rankHint').textContent = '马上开始，准备好摇动手机';
      return;
    }

    if (g.state === 'running') {
      var remain = g.duration - (Date.now() - g.startAt) / 1000;
      st.textContent = '摇起来！剩余 ' + (remain > 0 ? remain : 0).toFixed(1) + ' 秒';
      st.className = 'shake-status hot';
      if (zone) zone.classList.add('live');
      renderMiniRank();
      return;
    }

    // finished
    st.textContent = '本轮结束';
    st.className = 'shake-status';
    if (zone) zone.classList.remove('live');
    renderMiniRank();
  }

  var rankKey = '';

  function renderMiniRank() {
    var s = store.getState();
    var entries = Object.keys(s.game.scores).map(function (id) {
      return { id: id, score: s.game.scores[id] };
    }).sort(function (a, b) { return b.score - a.score; });

    // 该方法每 100ms 被调用一次，分数没变就不要重建 DOM
    var key = entries.map(function (e) { return e.id + ':' + e.score; }).join('|');
    if (key === rankKey) return;
    rankKey = key;

    if (!entries.length) {
      $('miniRank').innerHTML = '<div class="m-tip">暂无数据</div>';
      return;
    }

    var guests = {};
    s.guests.forEach(function (g) { guests[g.id] = g; });

    var myRank = -1;
    entries.forEach(function (e, i) { if (me && e.id === me.id) myRank = i + 1; });

    var html = entries.slice(0, 5).map(function (e, i) {
      var g = guests[e.id] || { name: '未知', avatar: '' };
      var isMe = me && e.id === me.id;
      return '<div style="display:flex;align-items:center;gap:.6rem;padding:.45rem 0;' +
        (isMe ? 'font-weight:700;color:var(--wine);' : '') + '">' +
        '<span style="width:1.5rem;text-align:center;color:' +
          (i === 0 ? '#d4af37' : '#b39a9d') + ';font-weight:700">' + (i + 1) + '</span>' +
        '<span style="font-size:1.3rem">' +
          (g.avatar && g.avatar.length > 12
            ? '<img src="' + g.avatar + '" style="width:1.8rem;height:1.8rem;border-radius:50%;object-fit:cover;vertical-align:middle">'
            : (g.avatar || '🌹')) +
        '</span>' +
        '<span style="flex:1">' + UI.escapeHtml(g.name) + (isMe ? '（我）' : '') + '</span>' +
        '<span style="font-variant-numeric:tabular-nums;color:var(--pink);font-weight:700">' +
          e.score + '</span>' +
      '</div>';
    }).join('');

    if (myRank > 5) {
      html += '<div style="text-align:center;padding:.5rem;color:var(--ink-soft);font-size:.85rem">' +
        '你的名次：第 ' + myRank + ' 名（' + (s.game.scores[me.id] || 0) + ' 次）</div>';
    }

    $('miniRank').innerHTML = html;

    if (myRank > 0) {
      $('rankHint').textContent = '你当前第 ' + myRank + ' 名，共 ' +
        (s.game.scores[me.id] || 0) + ' 次';
    }
  }

  function bindGame() {
    $('shakeCircle').addEventListener('click', function () {
      if (!me) { UI.toast('请先签到'); return; }
      if (!gameIsRunning()) {
        UI.toast('游戏还没开始哦');
        return;
      }
      doShake();
    });

    // 兜底：即使陀螺仪可用，点击也计分（有些老人机摇不动）
    $('shakeCircle').addEventListener('touchstart', function (e) {
      e.preventDefault();
    }, { passive: false });
  }

  /* ==================== 我的 ==================== */

  var meKey = '';

  function renderMe() {
    if (!me) return;
    var s = store.getState();
    var win = s.winners.filter(function (w) { return w.guestId === me.id; })[0];

    var key = me.name + '|' + me.avatar + '|' + (win ? win.id : '');
    if (key === meKey) return;
    meKey = key;

    $('meName').textContent = me.name;
    $('meAvatar').innerHTML = me.avatar && me.avatar.length > 12
      ? '<img src="' + me.avatar + '" alt="">'
      : (me.avatar || '🌹');

    $('winInfo').innerHTML = win
      ? '<div class="win-banner">🎉 恭喜你中奖啦！<br>获得 <span class="prize">' +
        UI.escapeHtml(win.prize) + '</span></div>'
      : '';
  }

  function bindMe() {
    $('btnEditProfile').addEventListener('click', function () {
      // 回到签到页并回填当前信息
      $('inpName').value = me ? me.name : '';
      selectedAvatar = me ? me.avatar : null;
      renderAvatarGrid();
      $('pageMain').classList.add('hidden');
      $('pageSignin').classList.remove('hidden');
      window.scrollTo(0, 0);
    });
  }

  /* ==================== Tab ==================== */

  function bindTabs() {
    document.querySelector('.m-tabs').addEventListener('click', function (e) {
      var tab = e.target.closest('.m-tab');
      if (!tab) return;
      var name = tab.getAttribute('data-tab');
      [].forEach.call(document.querySelectorAll('.m-tab'), function (t) {
        t.classList.toggle('active', t === tab);
      });
      ['bless', 'game', 'me'].forEach(function (k) {
        $('tab' + k.charAt(0).toUpperCase() + k.slice(1))
          .classList.toggle('active', k === name);
      });
      if (name === 'game') setupMotionIfNeeded();
    });
  }

  var motionSetupDone = false;
  function setupMotionIfNeeded() {
    if (motionSetupDone) return;
    motionSetupDone = true;
    setupMotion();
  }

  /* ==================== 循环刷新 ==================== */

  // 游戏计时与倒计时的显示需要按帧刷新，store 订阅只在数据变化时触发
  setInterval(function () {
    if (!me) return;
    var st = store.getState().game.state;
    if (st === 'running' || st === 'countdown') renderGameState();
  }, 100);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
