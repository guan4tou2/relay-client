// 命中解析器：把 sing-box 的 debug log 還原成「這條連線命中了哪一條規則」。
//
// 引擎跑在 log.level=debug，每條連線會印（同一個連線 ID 串起來）：
//   [ID 4ms] inbound/tun[tun-in]: inbound connection to HOST:PORT
//   [ID 9ms] router: sniffed protocol: tls, domain: HOST     （有嗅探才有；比 inbound 那行準）
//   [ID 9ms] router: match[N] <條件> => route(TAG) | reject   （沒命中就完全沒有這行）
//   [ID 9ms] outbound/xxx: outbound connection to ...         （連線定案）
//
// match[N] 的 N 就是 singbox.js 產生的 route.rules 索引，配上 ruleIndex 即可還原成使用者的規則。
//
// 抽成獨立模組的理由：原本埋在 main.js 裡，而 main.js 需要 electron 才能載入，
// 導致這段最新、最沒把握的邏輯完全無法單元測試。

// `inbound connection from` 也要吃掉：它每條連線一行，留著會把 app.log 灌滿
const PARSED = /router: (match\[|sniffed protocol)|inbound connection (to|from)|outbound connection to|connection closed/;

class HitParser {
  // getRuleIndex()：回傳目前這份設定的 route.rules 索引對照表（singbox.js 的 engine.ruleIndex）
  // onHit(hit)：一條連線定案時呼叫，hit = { host, info }
  constructor({ getRuleIndex, onHit } = {}) {
    this.getRuleIndex = getRuleIndex || (() => []);
    this.onHit = onHit || (() => {});
    this.pending = new Map();
  }

  reset() { this.pending.clear(); }

  // 回傳 true 代表「這行已被消化，呼叫端不要再寫進紀錄」
  consume(line) {
    if (!PARSED.test(line)) return false;
    const id = (line.match(/\[(\d{4,}) /) || [])[1];
    if (!id) return true;

    let m = line.match(/inbound connection to (\S+)/);
    if (m) { this.pending.set(id, { host: m[1], info: null }); return true; }

    m = line.match(/sniffed protocol: [^,]+, domain: (\S+)/);
    if (m) {
      const c = this.pending.get(id);
      // 嗅探到的網域比 inbound 那行的目的地準（TUN 下 inbound 只有 IP），但要保留埠
      if (c) { const port = c.host.includes(':') ? ':' + c.host.split(':').pop() : ''; c.host = m[1] + port; }
      return true;
    }

    m = line.match(/router: match\[(\d+)\]/);
    if (m) {
      const c = this.pending.get(id);
      const info = (this.getRuleIndex() || [])[Number(m[1])];
      if (c && info && info.kind !== 'sniff') c.info = info;   // sniff 不是使用者規則
      return true;
    }

    if (line.includes('outbound connection to') || line.includes('connection closed')) {
      const c = this.pending.get(id);
      if (c) { this.pending.delete(id); this.onHit(c); }
      return true;
    }
    return true;
  }
}

module.exports = { HitParser, PARSED };
