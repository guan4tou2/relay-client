'use strict';
// 純邏輯：不碰 DOM、不碰 state，瀏覽器與 Node 都能跑。放在這裡的函式有單元測試（test/renderer-lib.test.js）。
// 在畫面裡它跟其他檔一樣是一般 <script>、最先載入；測試用 Node 的 vm 執行這個檔再取出函式（見測試檔開頭）。

// 放進 innerHTML 前一律跳脫
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtBytes = b => { if (b < 1024) return b.toFixed(0) + ' B'; const u = ['KB', 'MB', 'GB']; let i = -1, n = b; while (n >= 1024 && i < 2) { n /= 1024; i++; } return n.toFixed(1) + ' ' + u[i]; };

const validPortStr = v => { const n = Number(v); return /^\d{1,5}$/.test(String(v)) && n >= 1 && n <= 65535; };
// 「443, 80, 3000-3999」：每一段是 1–65535 的埠或由小到大的區間（以前 \d{1,5} 連 99999 都收）
function validPortSpec(spec) {
  return String(spec).split(',').map(x => x.trim()).every(part => {
    const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(part);
    if (!m) return false;
    const lo = Number(m[1]), hi = m[2] ? Number(m[2]) : lo;
    return lo >= 1 && hi <= 65535 && lo <= hi;
  });
}
// IPv4 每段 0–255、前綴 ≤32；IPv6 交給 URL 解析器判斷、前綴 ≤128（以前 999.999.999.999 也算合法）
function validIpOrCidr(v) {
  const [addr, prefix, extra] = String(v).split('/');
  if (extra !== undefined) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    if (!addr.split('.').every(o => Number(o) <= 255)) return false;
    return prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
  }
  if (!addr.includes(':')) return false;
  try { new URL(`http://[${addr}]/`); } catch (e) { return false; }
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128);
}

// 把 net / 代理協定的原文錯誤翻成一句看得懂的原因；認不得的回空字串，由呼叫端退回「測試失敗」
function testFailReason(msg) {
  const m = String(msg || '');
  if (!m) return '';
  if (/certificate|CERT_|憑證/i.test(m)) return '憑證無法驗證';
  if (/ECONNREFUSED/i.test(m)) return '連線被拒';
  if (/ETIMEDOUT|timed? ?out|逾時/i.test(m)) return '逾時';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return '找不到主機';
  if (/ECONNRESET|socket hang up|closed/i.test(m)) return '連線被中斷';
  if (/auth|401|407|credential|password|帳密|認證/i.test(m)) return '驗證失敗';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(m)) return '網路無法到達';
  return '';
}

// 規則庫的「幾天前更新」（now 可傳入，測試用）
function fmtAge(ts, now = Date.now()) {
  if (!ts) return '未知';
  const d = Math.floor((now - ts) / 86400000);
  return d <= 0 ? '今天更新' : d === 1 ? '昨天更新' : d < 30 ? `${d} 天前更新` : `${Math.floor(d / 30)} 個月前更新`;
}

// 桶內取最大值降採樣：1000 點壓成 280 點時，突波不會被平均掉
function thinSeries(pts, n) {
  if (pts.length <= n) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * pts.length / n), b = Math.max(a + 1, Math.floor((i + 1) * pts.length / n));
    let d = 0, u = 0;
    for (let j = a; j < b; j++) { if (pts[j].down > d) d = pts[j].down; if (pts[j].up > u) u = pts[j].up; }
    out.push({ down: d, up: u });
  }
  return out;
}

// 規則條件的多值欄位：陣列，或以換行／逗號／分號分隔的字串
const splitVals = s => (Array.isArray(s) ? s : String(s == null ? '' : s).split(/[\n,;]+/)).map(x => String(x).trim()).filter(Boolean);

// ---- 匯入檔 ----
// 匯入檔 → { servers, routes }。舊版匯出檔整個是伺服器陣列；缺 host / port 的伺服器丟掉。
function parseImportFile(data) {
  if (Array.isArray(data)) return { servers: data.filter(s => s && s.host && s.port), routes: [] };
  const obj = data && typeof data === 'object' ? data : {};
  return {
    servers: (Array.isArray(obj.servers) ? obj.servers : []).filter(s => s && s.host && s.port),
    routes: Array.isArray(obj.routes) ? obj.routes : [],
  };
}

// 匯入檔是外部資料，路由存檔前在這裡整理：
//   - 埠或類型不合格 → { bad: true }（略過並計數）
//   - id 會拿去組瀏覽器 profile 的目錄名，不合格式的換成 fallbackId
//   - 跳點存的是伺服器 id：idMap 把匯出端的 id 對到這台機器的 id；對不回去的拿掉並計數
// 沒有 id 的整筆忽略（回傳 null）。其餘回傳 { route, lostHops }。
function normalizeImportedRoute(r, { idMap, known, fallbackId }) {
  if (!r || !r.id) return null;
  const port = Number(r.localPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (r.kind && r.kind !== 'socks5' && r.kind !== 'http')) return { bad: true };
  const id = /^[\w-]{1,64}$/.test(String(r.id)) ? String(r.id) : fallbackId;
  const hops = (Array.isArray(r.hops) ? r.hops : []).map(h => idMap.get(h) || (known.has(h) ? h : null));
  return {
    route: { id, label: String(r.label || ''), localPort: port, kind: r.kind || 'socks5', hops: hops.filter(Boolean), enabled: r.enabled !== false },
    lostHops: hops.filter(h => !h).length,
  };
}
