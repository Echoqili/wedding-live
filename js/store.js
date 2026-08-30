/**
 * store.js —— 婚礼现场互动数据层
 *
 * 设计要点：
 * 1. 所有页面（大屏 / 手机）只依赖统一接口：getState / subscribe / update
 * 2. 默认实现 LocalStore：localStorage 持久化 + BroadcastChannel 多标签实时同步
 * 3. 换成真机跨设备时，只需实现同样接口的 WSStore，业务代码零改动
 *
 * 之所以把「高频数据」和「低频数据」分开处理：
 *   摇一摇游戏每秒会产生几十次分数上报，如果每次都全量广播整个 state，
 *   大屏端会被自己的渲染压垮。因此对高频字段做节流合并。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'wedding_live_state_v1';
  var CHANNEL_NAME = 'wedding_live_sync';

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function uid(prefix) {
    return (prefix || 'id') + '_' +
      Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function createDefaultState() {
    return {
      // 婚礼基础信息，可在大屏「设置」里改
      config: {
        groom: '新郎',
        bride: '新娘',
        date: '',
        title: '',
        // 祝福是否需要新人审核后才上墙
        needReview: false,
        // 祝福弹幕飘屏开关（共享，主持控台可切换）
        danmaku: true,
        // 现场口令（4 位数字，留空=不启用鉴权；启用后主持控台与危险操作需验证）
        passcode: '',
        // 视觉与音乐定制（M2）：均为 URL 或 base64
        photos: { bg: '', couple: '', logo: '' },
        music: '',
        // 单个抽奖奖项
        prizes: [
          { id: 'p1', name: '三等奖', count: 5 },
          { id: 'p2', name: '二等奖', count: 3 },
          { id: 'p3', name: '一等奖', count: 1 }
        ]
      },
      // 签到嘉宾（抽奖候选池）
      guests: [],
      // 祝福
      blessings: [],
      // 中奖记录
      winners: [],
      // 摇一摇赛马
      game: {
        state: 'idle',          // idle | countdown | running | finished
        duration: 30,           // 秒
        startAt: 0,
        scores: {}              // { guestId: 次数 }
      },
      // 抽奖控制（主持控台与大屏共享，P0-4）
      lottery: {
        rolling: false,         // true=滚动中，大屏据此启动/停止滚动动画
        prizeId: null           // 当前选中的奖项 id
      },
      // 现场投票（M3-1）
      vote: {
        active: false,          // true=投票进行中
        question: '',
        options: [],            // [{id, text}]
        counts: {},             // {optId: 票数}
        votedBy: {},            // {guestId: optId}，支持改投
        resultShown: false      // 结束后大屏是否在展示结果
      },
      // 恋爱大事记（M3-2），轮播用
      timeline: [],             // [{id, year, title, desc}]
      // 大屏当前展示的模块，手机端可跟随
      stage: 'wall',            // wall | lottery | game
      updatedAt: 0
    };
  }

  /**
   * 合并远端状态：保留本端已有的对象结构，避免旧版本数据缺字段导致崩溃。
   */
  function mergeState(base, incoming) {
    if (!incoming || typeof incoming !== 'object') return base;
    var out = clone(base);
    ['config', 'game', 'lottery', 'vote'].forEach(function (k) {
      if (incoming[k] && typeof incoming[k] === 'object') {
        out[k] = Object.assign({}, out[k], incoming[k]);
      }
    });
    ['guests', 'blessings', 'winners', 'timeline'].forEach(function (k) {
      if (Array.isArray(incoming[k])) out[k] = incoming[k];
    });
    if (typeof incoming.stage === 'string') out.stage = incoming.stage;
    out.updatedAt = incoming.updatedAt || Date.now();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* LocalStore：同机多窗口 / 多标签实时同步                              */
  /* ------------------------------------------------------------------ */

  function LocalStore() {
    this._state = this._load();
    this._subs = [];
    this._broadcastTimer = null;
    this._pendingBroadcast = false;
    this._channel = null;

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this._channel = new BroadcastChannel(CHANNEL_NAME);
        var self = this;
        this._channel.onmessage = function (ev) {
          var data = ev.data;
          if (!data || data.type !== 'state') return;
          self._adopt(data.state, true);
        };
      } catch (e) {
        this._channel = null; // 某些老浏览器不支持，降级为仅本页可用
      }
    }

    // 兜底：部分浏览器不触发 storage/storage 事件不可靠时，可用 storage 事件
    var self2 = this;
    global.addEventListener('storage', function (ev) {
      if (ev.key !== STORAGE_KEY || !ev.newValue) return;
      // 已用 BroadcastChannel 时不重复处理
      if (self2._channel) return;
      try {
        self2._adopt(JSON.parse(ev.newValue).state, true);
      } catch (e) { /* 忽略脏数据 */ }
    });
  }

  LocalStore.prototype._load = function () {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultState();
      var parsed = JSON.parse(raw);
      return mergeState(createDefaultState(), parsed.state || parsed);
    } catch (e) {
      return createDefaultState();
    }
  };

  LocalStore.prototype._persist = function () {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        state: this._state,
        v: 1
      }));
    } catch (e) {
      // 配额超限时通常是头像图片过多，提示而不是静默失败
      console.warn('[store] 持久化失败，可能超出 localStorage 配额', e);
    }
  };

  LocalStore.prototype._adopt = function (incoming, fromRemote) {
    this._state = mergeState(this._state, incoming);
    this._emit(fromRemote);
  };

  /**
   * 广播给其他标签页。throttle=true 时合并高频写入。
   */
  LocalStore.prototype._broadcast = function (throttle) {
    if (!this._channel) return;
    var self = this;
    if (throttle) {
      this._pendingBroadcast = true;
      if (this._broadcastTimer) return;
      this._broadcastTimer = setTimeout(function () {
        self._broadcastTimer = null;
        if (!self._pendingBroadcast) return;
        self._pendingBroadcast = false;
        self._channel.postMessage({ type: 'state', state: clone(self._state) });
      }, 120);
    } else {
      this._channel.postMessage({ type: 'state', state: clone(this._state) });
    }
  };

  LocalStore.prototype._emit = function (fromRemote) {
    var snapshot = this._state;
    this._subs.forEach(function (fn) {
      try { fn(snapshot, !!fromRemote); } catch (e) { console.error(e); }
    });
  };

  LocalStore.prototype.getState = function () {
    return this._state;
  };

  /**
   * 修改状态。
   * @param {function(object):void} mutator 直接修改传入的 state 草稿
   * @param {{throttle?:boolean, silent?:boolean, persist?:boolean}} opts
   *        throttle 合并广播（用于摇一摇等高频写入）
   *        silent   不广播（仅本页生效，用于纯 UI 状态）
   *        persist  是否写入 localStorage，默认 true
   */
  LocalStore.prototype.update = function (mutator, opts) {
    opts = opts || {};
    mutator(this._state);
    this._state.updatedAt = Date.now();
    if (opts.persist !== false) this._persist();
    if (!opts.silent) this._broadcast(!!opts.throttle);
    this._emit(false);
  };

  LocalStore.prototype.subscribe = function (fn) {
    this._subs.push(fn);
    var self = this;
    return function () {
      var i = self._subs.indexOf(fn);
      if (i >= 0) self._subs.splice(i, 1);
    };
  };

  LocalStore.prototype.reset = function () {
    this._state = createDefaultState();
    this._persist();
    this._broadcast(false);
    this._emit(false);
  };

  /**
   * 摇分快捷通道。与 RemoteStore.bump 保持同名同义：
   * Actions.bumpScore 会优先走这个方法。本地节流广播，行为与旧版一致。
   */
  LocalStore.prototype.bump = function (guestId, delta) {
    this.update(function (s) {
      if (s.game.state !== 'running') return;
      s.game.scores[guestId] = (s.game.scores[guestId] || 0) + (delta || 1);
    }, { throttle: true, persist: false });
  };

  /* ------------------------------------------------------------------ */
  /* 业务动作（大屏和手机共用，避免两边写出不一致的逻辑）                  */
  /* ------------------------------------------------------------------ */

  var Actions = {
    uid: uid,

    signIn: function (store, payload) {
      var guest = null;
      store.update(function (s) {
        // 同名重复签到：更新头像而不新增，避免嘉宾池被刷爆
        var exist = s.guests.filter(function (g) {
          return g.name === payload.name;
        })[0];
        if (exist) {
          exist.avatar = payload.avatar || exist.avatar;
          exist.ts = Date.now();
          guest = exist;
        } else {
          guest = {
            id: uid('g'),
            name: payload.name,
            avatar: payload.avatar || '',
            ts: Date.now()
          };
          s.guests.push(guest);
        }
      });
      return guest;
    },

    addBlessing: function (store, payload) {
      var b = null;
      store.update(function (s) {
        b = {
          id: uid('b'),
          name: payload.name || '匿名宾客',
          avatar: payload.avatar || '',
          text: payload.text,
          color: payload.color || '#e8b4b8',
          ts: Date.now(),
          approved: !s.config.needReview
        };
        s.blessings.push(b);
      });
      return b;
    },

    approveBlessing: function (store, id, approved) {
      store.update(function (s) {
        s.blessings.forEach(function (b) {
          if (b.id === id) b.approved = approved !== false;
        });
      });
    },

    removeBlessing: function (store, id) {
      store.update(function (s) {
        s.blessings = s.blessings.filter(function (b) { return b.id !== id; });
      });
    },

    /** 返回本轮中奖者数组；奖池不足时返回实际抽到的人 */
    draw: function (store, prizeId) {
      var result = [];
      store.update(function (s) {
        var prize = s.config.prizes.filter(function (p) {
          return p.id === prizeId;
        })[0];
        if (!prize) return;

        var used = {};
        s.winners.forEach(function (w) { used[w.guestId] = true; });

        var pool = s.guests.filter(function (g) { return !used[g.id]; });
        var n = Math.min(prize.count, pool.length);

        // Fisher-Yates 洗牌后取前 n 个，保证不重复且分布均匀
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        for (var k = 0; k < n; k++) {
          var w = {
            id: uid('w'),
            guestId: pool[k].id,
            name: pool[k].name,
            avatar: pool[k].avatar,
            prize: prize.name,
            prizeId: prize.id,
            ts: Date.now()
          };
          s.winners.push(w);
          result.push(w);
        }
      });
      return result;
    },

    clearWinners: function (store, prizeId) {
      store.update(function (s) {
        if (prizeId) {
          s.winners = s.winners.filter(function (w) { return w.prizeId !== prizeId; });
        } else {
          s.winners = [];
        }
      });
    },

    startGame: function (store, duration) {
      store.update(function (s) {
        s.game.state = 'countdown';
        s.game.duration = duration || s.game.duration || 30;
        s.game.startAt = Date.now() + 3000; // 3 秒倒计时
        s.game.scores = {};
      });
    },

    /** 游戏开始（由大屏倒计时结束后调用一次） */
    runGame: function (store) {
      store.update(function (s) {
        s.game.state = 'running';
        s.game.startAt = Date.now();
      });
    },

    /**
     * 摇分入口。若 store 实现了 bump()（RemoteStore），走轻量协议：
     * 只上报 {guestId, delta}，由服务端聚合广播，避免全量 state 打爆带宽。
     * LocalStore 也提供 bump()，保持两条路径行为一致。
     */
    bumpScore: function (store, guestId, delta) {
      if (typeof store.bump === 'function') {
        store.bump(guestId, delta);
        return;
      }
      store.update(function (s) {
        if (s.game.state !== 'running') return;
        s.game.scores[guestId] = (s.game.scores[guestId] || 0) + (delta || 1);
      }, { throttle: true, persist: false });
    },

    /** 主持控台 / 大屏共用的抽奖滚动开关（走共享 state，见 P0-4） */
    setLotteryRolling: function (store, rolling) {
      store.update(function (s) {
        if (!s.lottery) s.lottery = { rolling: false, prizeId: null };
        s.lottery.rolling = rolling !== false;
      });
    },

    /** 切换当前奖项（主持控台 / 大屏共用） */
    setLotteryPrize: function (store, prizeId) {
      store.update(function (s) {
        if (!s.lottery) s.lottery = { rolling: false, prizeId: null };
        s.lottery.prizeId = prizeId;
      });
    },

    /** 发起投票（M3-1）：payload = {question, options: [{id,text}]} */
    startVote: function (store, payload) {
      store.update(function (s) {
        if (!s.vote) s.vote = { active: false, question: '', options: [], counts: {}, votedBy: {}, resultShown: false };
        s.vote.active = true;
        s.vote.question = payload.question || '现场投票';
        s.vote.options = payload.options && payload.options.length
          ? payload.options : [{ id: 'o1', text: '是' }, { id: 'o2', text: '否' }];
        var counts = {};
        s.vote.options.forEach(function (o) { counts[o.id] = 0; });
        s.vote.counts = counts;
        s.vote.votedBy = {};
        s.vote.resultShown = false;
      });
    },

    /** 投票 / 改投（M3-1）：guestId 投 optionId，可反复改投直到结束 */
    castVote: function (store, guestId, optionId) {
      store.update(function (s) {
        if (!s.vote || !s.vote.active) return;
        var v = s.vote;
        // 改投：撤销旧票
        if (v.votedBy[guestId] && v.votedBy[guestId] !== optionId) {
          var old = v.votedBy[guestId];
          if (v.counts[old] != null) v.counts[old] = Math.max(0, v.counts[old] - 1);
        }
        if (v.votedBy[guestId] === optionId) return; // 同选项再点 = 不变
        v.votedBy[guestId] = optionId;
        if (v.counts[optionId] == null) v.counts[optionId] = 0;
        v.counts[optionId]++;
      });
    },

    /** 结束投票（M3-1）：active=false，保留结果供大屏展示 */
    endVote: function (store) {
      store.update(function (s) {
        if (!s.vote) return;
        s.vote.active = false;
        s.vote.resultShown = true;
      });
    },

    /** 保存恋爱大事记（M3-2）：items = [{year, title, desc}] */
    setTimeline: function (store, items) {
      store.update(function (s) {
        s.timeline = items.map(function (it, i) {
          return {
            id: (it.id) || 't' + Date.now() + '_' + i,
            year: String(it.year || '').trim(),
            title: String(it.title || '').trim(),
            desc: String(it.desc || '').trim()
          };
        });
      });
    },

    finishGame: function (store) {
      store.update(function (s) {
        s.game.state = 'finished';
      });
    },

    resetGame: function (store) {
      store.update(function (s) {
        s.game.state = 'idle';
        s.game.scores = {};
        s.game.startAt = 0;
      });
    },

    setStage: function (store, stage) {
      store.update(function (s) { s.stage = stage; });
    },

    updateConfig: function (store, patch) {
      store.update(function (s) {
        s.config = Object.assign({}, s.config, patch);
      });
    },

    setPrizes: function (store, prizes) {
      store.update(function (s) { s.config.prizes = prizes; });
    },

    removeGuest: function (store, id) {
      store.update(function (s) {
        s.guests = s.guests.filter(function (g) { return g.id !== id; });
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* 导出                                                                */
  /* ------------------------------------------------------------------ */

  global.WeddingStore = {
    LocalStore: LocalStore,
    Actions: Actions,
    create: function () { return new LocalStore(); },
    createDefaultState: createDefaultState,
    /**
     * 允许外部注入自定义实现（如 WSStore）。
     * 调用后，后续 WeddingStore.create() 会返回新实现。
     */
    setImplementation: function (Impl) {
      this.create = function () { return new Impl(); };
    }
  };
})(window);
