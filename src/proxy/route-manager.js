const { EventEmitter } = require('events');
const SocksRelay = require('./socks-relay');
const HttpBridge = require('./http-bridge');

// 多端口路由管理：每個 route = 一個本地 port → 一條上游（單一 proxy 或多跳串鏈）。
// 每個 route 各自起一個 SocksRelay(kind='socks5') 或 HttpBridge(kind='http')，彼此獨立。
//
// route 結構：{ id, localPort, kind: 'socks5'|'http', hops: [proxyObj, ...] }
//   hops 已是解析後的 proxy 物件陣列（host/port/type/username/password）；長度 1 = 單跳。
class RouteManager extends EventEmitter {
  constructor() {
    super();
    this.running = new Map(); // routeId → { relay, route }
  }

  async start(route) {
    this._validate(route);
    if (this.running.has(route.id)) await this.stop(route.id);

    const Relay = route.kind === 'http' ? HttpBridge : SocksRelay;
    const relay = new Relay();
    relay.on('stats', (s) => this.emit('stats', route.id, s));
    relay.on('log', (level, msg, detail) => this.emit('log', route.id, level, msg, detail));
    relay.on('error', (err) => this.emit('error', route.id, err));

    const upstream = route.hops.length === 1 ? route.hops[0] : route.hops;
    await relay.start(route.localPort, upstream);

    this.running.set(route.id, { relay, route });
    this.emit('started', route.id);
    return route.id;
  }

  async stop(routeId) {
    const entry = this.running.get(routeId);
    if (!entry) return false;
    this.running.delete(routeId);
    await entry.relay.stop();
    this.emit('stopped', routeId);
    return true;
  }

  async stopAll() {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  // 依新的 route 清單同步：不在清單或已停用的就停、清單內啟用的就起。回傳每個 route 的結果。
  async apply(routes) {
    const wanted = new Map(routes.filter((r) => r.enabled !== false).map((r) => [r.id, r]));
    const results = [];
    // 停掉不再需要的
    for (const id of [...this.running.keys()]) {
      if (!wanted.has(id)) await this.stop(id);
    }
    // 起 / 重起需要的
    for (const [id, route] of wanted) {
      try {
        if (this.running.has(id)) { results.push({ id, ok: true, already: true }); continue; }
        await this.start(route);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    return results;
  }

  isRunning(routeId) { return this.running.has(routeId); }

  status() {
    return [...this.running.values()].map(({ relay, route }) => ({
      id: route.id, localPort: route.localPort, kind: route.kind, hops: route.hops.length,
      running: relay.running,
    }));
  }

  _validate(route) {
    if (!route || route.id == null) throw new Error('route.id required');
    if (!Number.isInteger(route.localPort) || route.localPort < 1 || route.localPort > 65535) throw new Error(`invalid localPort: ${route.localPort}`);
    if (route.kind !== 'socks5' && route.kind !== 'http') throw new Error(`invalid kind: ${route.kind}`);
    if (!Array.isArray(route.hops) || route.hops.length === 0) throw new Error('route.hops must be a non-empty array');
  }
}

// 純函式：偵測路由清單的埠衝突（與主連線埠、與彼此重複），供 main.applyRoutes 與單元測試共用。
// 不含「外部程式占用」檢查（那需 I/O）。回傳 { clear, conflicts:[{ id, port, reason:'primary'|'duplicate', with? }] }。
// 重複以宣告順序判定：同一埠第一條保留，其後同埠者標記為 duplicate。
function detectPortConflicts(routes, primaryPorts = []) {
  const conflicts = [];
  const clear = [];
  const seen = new Map(); // localPort → 先占用的 route id
  for (const r of routes) {
    if (primaryPorts.includes(r.localPort)) { conflicts.push({ id: r.id, port: r.localPort, reason: 'primary' }); continue; }
    if (seen.has(r.localPort)) { conflicts.push({ id: r.id, port: r.localPort, reason: 'duplicate', with: seen.get(r.localPort) }); continue; }
    seen.set(r.localPort, r.id);
    clear.push(r);
  }
  return { clear, conflicts };
}

module.exports = RouteManager;
module.exports.detectPortConflicts = detectPortConflicts;
