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
    ['config', 'game'].forEach(function (k) {
      if (incoming[k] && typeof incoming[k] === 'object') {
        out[k] = Object.assign({}, out[k], incoming[k]);
      }
    });
    ['guests', 'blessings', 'winners'].forEach(function (k) {
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

    bumpScore: function (store, guestId, delta) {
      store.update(function (s) {
        if (s.game.state !== 'running') return;
        s.game.scores[guestId] = (s.game.scores[guestId] || 0) + (delta || 1);
      }, { throttle: true, persist: false });
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
