// 轉送時關掉 Nagle：兩端各自緩衝小封包會讓 SSH、遊戲這類互動流量每次多等一個 ACK（最多約 40ms）。
// 我們只是中繼，合併封包是兩端應用程式的事，不該在中間再攢一次。
function noDelay(...sockets) {
  for (const s of sockets) { try { if (s && s.setNoDelay) s.setNoDelay(true); } catch (e) {} }
}

module.exports = { noDelay };
