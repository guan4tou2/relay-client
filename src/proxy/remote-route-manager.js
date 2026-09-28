const { EventEmitter } = require('events');

// 主行程這一側的 RouteManager 替身：介面跟 RouteManager 一樣（start / stop / stopAll /
// isRunning / status + log / error / stats / started / stopped 事件），實際的轉送跑在
// relay-host.js 那個獨立行程裡。協定見 relay-host.js 檔頭。
//
// status() 與 isRunning() 在呼叫端是同步的（系統匣、系統代理都這樣用），所以這裡維護一份
// 由對方推過來的狀態快照，不必每次都跨行程問。
//
// 中繼行程意外結束（當掉、被防毒砍掉）時：所有路由都停了，先照實回報，再自動重開一次、
// 把原本在跑的路由拉回來。一分鐘內連續當掉太多次就不再重開，交給使用者處理。
// 重開（或放棄重開）之後送 'settled'，呼叫端據此檢查系統代理是否還指著活的路由。
//
// 行程根本起不來（從沒送過 ready 就結束、或 spawn 直接丟例外）時，若有給 fallback，
// 就改用主行程裡的 RouteManager 轉送 —— 慢一點總比所有路由都不能用好，並記一筆警告。
const CALL_TIMEOUT_MS = 15000;
const RESTART_WINDOW_MS = 60000;
const RESTART_MAX = 3;

class RemoteRouteManager extends EventEmitter {
  // spawn：() => child，child 要有 postMessage(msg)、on('message'|'exit', fn)、kill()
  // fallback：() => RouteManager（可省略）
  constructor({ spawn, fallback }) {
    super();
    this._spawn = spawn;
    this._fallback = fallback || null;
    this._local = null;          // 退回主行程轉送時的 RouteManager
    this._everReady = false;
    this._child = null;
    this._ready = null;          // Promise：對方送 ready 之後才送指令
    this._pending = new Map();   // 指令 id → { resolve, reject, timer }
    this._seq = 0;
    this._status = [];
    this._defs = new Map();      // 在跑的路由定義（重開行程時拿來拉回路由）
    this._restarts = [];
    this._disposed = false;
  }

  _ensure() {
    if (this._child) return this._ready;
    const child = this._spawn();
    this._child = child;
    this._ready = /** @type {Promise<void>} */ (new Promise((resolve, reject) => { this._onReady = resolve; this._onNeverReady = reject; }));
    this._ready.catch(() => {});   // 由 _call 處理；這裡只避免 unhandled rejection
    child.on('message', (msg) => this._onMessage(child, msg));
    child.on('exit', (code) => this._onExit(child, code));
    return this._ready;
  }

  _useLocal(reason) {
    if (this._local) return;
    this._local = this._fallback();
    for (const ev of ['log', 'stats', 'started', 'stopped']) this._local.on(ev, (...a) => this.emit(ev, ...a));
    this._local.on('error', (...a) => { if (this.listenerCount('error')) this.emit('error', ...a); });
    this.emit('log', 'relay', 'warn', `無法啟動獨立的中繼行程，改在主行程轉送（${reason}）`);
  }

  _onMessage(child, msg) {
    if (child !== this._child || !msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') { this._everReady = true; this._onReady(); return; }
    if (msg.type === 'status') { this._status = Array.isArray(msg.list) ? msg.list : []; return; }
    if (msg.type === 'reply') {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || '中繼行程回報失敗'));
      return;
    }
    if (msg.type === 'event') {
      const args = Array.isArray(msg.args) ? msg.args : [];
      if (msg.name === 'error') {
        // 跟 RouteManager 一樣：沒人聽 error 時不要讓 EventEmitter 拋未處理例外
        if (this.listenerCount('error')) this.emit('error', args[0], new Error((args[1] && args[1].message) || '未知錯誤'));
        return;
      }
      if (['log', 'stats', 'started', 'stopped'].includes(msg.name)) this.emit(msg.name, ...args);
    }
  }

  _onExit(child, code) {
    if (child !== this._child) return;
    this._child = null;
    this._ready = null;
    const err = new Error(`中繼行程意外結束（code ${code}）`);
    if (!this._everReady) { this._onNeverReady(err); return; }   // 從沒起來過：交給 _call 決定要不要退回主行程
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
    const wasRunning = this._status.map(s => s.id);
    this._status = [];
    if (this._disposed) return;
    for (const id of wasRunning) this.emit('stopped', id);
    this.emit('log', 'relay', 'error', err.message, wasRunning.length ? `受影響的路由：${wasRunning.join(', ')}` : null);
    this.emit('crashed', code);
    this._maybeRestart();
  }

  _maybeRestart() {
    const now = Date.now();
    this._restarts = this._restarts.filter(t => now - t < RESTART_WINDOW_MS);
    if (this._restarts.length >= RESTART_MAX) {
      this.emit('log', 'relay', 'error', `中繼行程一分鐘內結束了 ${RESTART_MAX} 次，不再自動重開；請重新啟動路由或重開 app`);
      this._defs.clear();
      this.emit('settled');
      return;
    }
    this._restarts.push(now);
    const defs = [...this._defs.values()];
    if (!defs.length) return;   // 沒有路由在跑：等下一個指令再開行程就好
    (async () => {
      for (const def of defs) {
        try { await this.start(def); }
        catch (e) { this.emit('log', def.id, 'error', `中繼行程重開後無法恢復路由：${e.message}`); }
      }
      this.emit('log', 'relay', 'info', `中繼行程已重開，恢復 ${defs.length} 條路由`);
      this.emit('settled');
    })();
  }

  async _call(op, ...args) {
    if (this._local) return this._local[op](...args);
    try {
      await this._ensure();
    } catch (e) {
      this._child = null;
      if (!this._fallback || this._everReady) throw e;
      this._useLocal(e.message);
      return this._local[op](...args);
    }
    const child = this._child;
    if (!child) throw new Error('中繼行程未啟動');
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`中繼行程沒有回應（${op}）`));
      }, CALL_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      try { child.postMessage({ id, op, args }); }
      catch (e) { this._pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  async start(route) {
    const r = await this._call('start', route);
    this._defs.set(route.id, route);
    return r;
  }

  async stop(routeId) {
    this._defs.delete(routeId);
    if (this._local) return this._local.stop(routeId);
    if (!this._child) return false;
    return this._call('stop', routeId);
  }

  async stopAll() {
    this._defs.clear();
    if (this._local) return this._local.stopAll();
    if (!this._child) return;
    await this._call('stopAll');
  }

  isRunning(routeId) { return this._local ? this._local.isRunning(routeId) : this._status.some(s => s.id === routeId); }

  status() { return this._local ? this._local.status() : this._status.map(s => ({ ...s })); }

  // 結束 app 時呼叫（先 stopAll 把 socket 收乾淨，再收掉行程）
  dispose() {
    this._disposed = true;
    this._defs.clear();
    const child = this._child;
    this._child = null;
    if (child) { try { child.kill(); } catch (e) {} }
  }
}

module.exports = RemoteRouteManager;
