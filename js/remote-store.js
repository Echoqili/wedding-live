/**
 * remote-store.js —— 真机跨设备同步的 Store 实现
 *
 * 与 LocalStore 实现同一组接口（getState / subscribe / update），
 * 通过 WebSocket 与 server.js 通讯，达成多台手机 + 大屏的最终一致。
 *
 * 用法（screen.html / mobile.html 顶部）：
 *   <script src="js/store.js"></script>
 *   <script src="js/remote-store.js"></script>
 *   <script>
 *     // 根据 ?ws= 参数自动切换
 *     var params = new URLSearchParams(location.search);
 *     if (params.get('ws')) {
 *       WeddingStore.setImplementation(WeddingRemoteStore);
 *     }
 *   </script>
 *   <script src="js/screen.js"></script>
 *
 * 一致性策略：
 *   1. update() 立即修改本地 state 并 emit（乐观更新）
 *   2. 通过 ws 把新 state 发给服务端
 *   3. 服务端存为权威，递增 seq 后广播
 *   4. 客户端只接受 seq 严格递增的 state
 *   5. 多客户端并发时形成「最后到达服务端者胜」，所有客户端最终看到同一份 state
 */
(function (global) {
  'use strict';

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function RemoteStore(url) {
    if (!url) throw new Error('RemoteStore 需要传入 WebSocket 地址');

    // 用默认 state 初始化，避免 ws 尚未连上时 UI 渲染报错
    this._state = WeddingStore.createDefaultState();
    this._subs = [];
    this._lastSeq = -1;
    this._connected = false;
    this._queue = [];      // 离线时缓存的 state
    this._reconnectTimer = null;
    this._url = url;

    this._connect();
  }

  RemoteStore.prototype._connect = function () {
    var self = this;
    try {
      this._ws = new WebSocket(this._url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = function () {
      self._connected = true;
      // 拉取服务端当前 state（如果有）
      try { self._ws.send(JSON.stringify({ type: 'pull' })); } catch (e) {}
      // 推送本地缓存
      while (self._queue.length) {
        try { self._ws.send(self._queue.shift()); } catch (e) { break; }
      }
    };

    this._ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg) return;
      if (msg.type === 'state') {
        if (msg.state == null) return; // 提示性消息
        // 只接受 seq 严格递增的 state
        if (msg.seq <= self._lastSeq && self._state) return;
        self._lastSeq = msg.seq;
        self._state = msg.state;
        self._emit(true);
      } else if (msg.type === 'scores') {
        /* 摇分聚合广播（P0-1）：服务端每 200ms 推一次纯数字 map。
           本地合并后通知订阅者，但不回推全量 state（否则形成回环）。 */
        if (!self._state) return;
        if (!self._state.game) self._state.game = { state: 'idle', scores: {} };
        self._state.game.scores = msg.scores || {};
        self._emit(true);
      } else if (msg.type === 'reset') {
        self._state = null;
        self._lastSeq = -1;
        self._emit(true);
      }
    };

    this._ws.onclose = function () {
      self._connected = false;
      self._scheduleReconnect();
    };

    this._ws.onerror = function () {
      // 让 onclose 处理重连
    };
  };

  RemoteStore.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self._connect();
    }, 2000);
  };

  RemoteStore.prototype._emit = function (fromRemote) {
    var snapshot = this._state;
    this._subs.forEach(function (fn) {
      try { fn(snapshot, !!fromRemote); } catch (e) { console.error(e); }
    });
  };

  RemoteStore.prototype.getState = function () { return this._state; };

  /**
   * 摇分轻量通道（P0-1 核心）。
   * 本地立即生效（乐观更新），但只上报 {type:'score', guestId, delta}，
   * 全量 state 不参与——否则 50 人摇一摇每秒会有几百份 1MB 广播。
   * 服务端聚合后每 200ms 广播一次 scores，在 onmessage 里合并回来。
   */
  RemoteStore.prototype.bump = function (guestId, delta) {
    if (!this._state || !this._state.game || this._state.game.state !== 'running') return;
    delta = delta || 1;
    this._state.game.scores[guestId] = (this._state.game.scores[guestId] || 0) + delta;
    this._emit(false);

    if (this._connected && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ type: 'score', guestId: guestId, delta: delta }));
      } catch (e) { /* 摇分丢失可容忍，不做离线队列（避免重连后爆量） */ }
    }
  };

  RemoteStore.prototype.update = function (mutator, opts) {
    opts = opts || {};
    if (!this._state) this._state = WeddingStore.createDefaultState();
    mutator(this._state);
    this._state.updatedAt = Date.now();

    // 乐观更新：立即通知订阅者
    this._emit(false);

    // 发送给服务端
    var payload = JSON.stringify({ type: 'state', state: this._state });
    if (this._connected && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(payload); } catch (e) { this._queue.push(payload); }
    } else {
      this._queue.push(payload);
    }
  };

  RemoteStore.prototype.subscribe = function (fn) {
    this._subs.push(fn);
    var self = this;
    return function () {
      var i = self._subs.indexOf(fn);
      if (i >= 0) self._subs.splice(i, 1);
    };
  };

  RemoteStore.prototype.reset = function () {
    this._state = WeddingStore.createDefaultState();
    this._emit(false);
    if (this._connected && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ type: 'reset' })); } catch (e) {}
    }
  };

  global.WeddingRemoteStore = RemoteStore;
})(window);
