// 中繼的獨立行程進入點（Electron utilityProcess）。
//
// 為什麼要搬出主行程：每條路由的 SOCKS / HTTP 轉送都是 socket 事件，跑在主行程的話
// 跟 IPC、系統匣、視窗事件共用同一個事件迴圈 —— 流量一大介面就卡，反過來介面忙的時候
// 轉送也會跟著停頓。搬到這裡之後主行程只收指令結果與統計。
//
// 協定（兩邊都是結構化複製的純物件）：
//   主行程 → 這裡：{ id, op: 'start'|'stop'|'stopAll', args: [...] }
//   這裡 → 主行程：
//     { type: 'ready' }                                  啟動完成，可以送指令
//     { type: 'reply', id, ok, result?, error? }         指令結果
//     { type: 'status', list }                           路由狀態快照（每次有變化就送）
//     { type: 'event', name: 'log'|'error'|'stats'|'started'|'stopped', args }
// 狀態快照一定在 'started' / 'stopped' 事件與指令回覆之前送出，主行程收到回覆時快取已是最新。
const RouteManager = require('./route-manager');

// port：{ postMessage(msg), on('message', handler) }。handler 收到的是訊息本身。
function attach(port) {
  const rm = new RouteManager();
  const post = (msg) => { try { port.postMessage(msg); } catch (e) { /* 主行程已經不在 */ } };
  const snapshot = () => post({ type: 'status', list: rm.status() });
  const event = (name, ...args) => post({ type: 'event', name, args });

  rm.on('log', (routeId, level, msg, detail) => event('log', routeId, level, msg, detail));
  rm.on('error', (routeId, err) => { snapshot(); event('error', routeId, { message: (err && err.message) || String(err) }); });
  rm.on('stats', (routeId, stats) => event('stats', routeId, stats));
  rm.on('started', (routeId) => { snapshot(); event('started', routeId); });
  rm.on('stopped', (routeId) => { snapshot(); event('stopped', routeId); });

  port.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { id, op, args = [] } = msg;
    try {
      let result;
      if (op === 'start') result = await rm.start(args[0]);
      else if (op === 'stop') result = await rm.stop(args[0]);
      else if (op === 'stopAll') result = await rm.stopAll();
      else throw new Error(`unknown op: ${op}`);
      snapshot();
      post({ type: 'reply', id, ok: true, result });
    } catch (err) {
      snapshot();
      post({ type: 'reply', id, ok: false, error: (err && err.message) || String(err) });
    }
  });

  post({ type: 'ready' });
  return rm;
}

// 當成行程進入點時才接上：
//   Electron utilityProcess → process.parentPort（只有 utility process 才有；訊息包在 e.data 裡）
//   Node child_process.fork（單元測試用）→ process.send / process.on('message')。
//   這條要多檢查 require.main：jest 的 worker 本身也有 process.send，被 require 時不能接上去。
if (process.parentPort) {
  const pp = process.parentPort;
  attach({ postMessage: (m) => pp.postMessage(m), on: (_ev, fn) => pp.on('message', (e) => fn(e.data)) });
} else if (require.main === module && process.send) {
  attach({ postMessage: (m) => process.send(m), on: (_ev, fn) => process.on('message', fn) });
  process.on('disconnect', () => process.exit(0));   // 父行程不在了就跟著結束，不要留孤兒
}

// 逐一掛在 module.exports 上：.js 裡的 object literal 型別是「可擴充的」，
// 寫成 module.exports = { ... } 的話 npm run typecheck 抓不到呼叫端拼錯的名字。
module.exports.attach = attach;
