// 轉送時關掉 Nagle：兩端各自緩衝小封包會讓 SSH、遊戲這類互動流量每次多等一個 ACK（最多約 40ms）。
// 我們只是中繼，合併封包是兩端應用程式的事，不該在中間再攢一次。
function noDelay(...sockets) {
  for (const s of sockets) { try { if (s && s.setNoDelay) s.setNoDelay(true); } catch (e) {} }
}

// 逐一掛在 module.exports 上：.js 裡的 object literal 型別是「可擴充的」，
// 寫成 module.exports = { ... } 的話 npm run typecheck 抓不到呼叫端拼錯的名字。
module.exports.noDelay = noDelay;
