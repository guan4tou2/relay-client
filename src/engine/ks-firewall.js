// 斷線保護的第二道防線：作業系統防火牆（目前只有 Windows 實作）。
//
// 為什麼需要（issue #3）：sing-box 一死，Windows 會連同 TUN 與 0.0.0.0/0 路由一起移除，
// 流量立刻退回實體網卡；封鎖模式要重建一張 TUN 才生效，實測空窗約 5 秒。
//
// 做法：引擎執行期間就預先布防，對每支受保護程式加一條防火牆規則：
//   「本機位址不是 TUN（172.19.0.0/30）」且「對方不是內網」→ 封鎖
// 正常時受保護程式的流量走 TUN，來源位址是 172.19.0.1，規則不命中，完全沒有影響；
// TUN 一消失，同一支程式的連線改從實體網卡出去、來源變成實體 IP，規則當下就擋，
// 不必等任何行程反應。內網照常（印表機、NAS 不受影響）。
//
// 涵蓋範圍（誠實版）：防火牆只能依「程式路徑」比對，所以只保護
//   - 「只保護以下程式」模式列出的程式
//   - 規則表裡「依程式」而且原本要走代理（或封鎖）的規則
// 純網域／IP 規則與全域模式沒有程式可以比對，仍然只靠封鎖模式（有數秒空窗）。
// 以名稱（chrome.exe）指定的程式要先找到完整路徑：布防時掃一次執行中的程式，之後定期補。

const TUN_CIDR = '172.19.0.0/30';
// 對方位址在這些範圍內不擋：本機、內網、鏈路本地、CGNAT、群播、廣播（跟 singbox.js 的 PRIVATE_CIDRS 同一份語意）
const LOCAL_CIDRS_V4 = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '224.0.0.0/4', '255.255.255.255/32'];
const LOCAL_CIDRS_V6 = ['::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'];

// ---- 位址範圍（純函式，IPv4 / IPv6 共用 BigInt 實作）----
const BITS = { 4: 32, 6: 128 };

function parseIp(ip, family) {
  if (family === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('bad ipv4: ' + ip);
    return p.reduce((a, n) => (a << 8n) | BigInt(n), 0n);
  }
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) throw new Error('bad ipv6: ' + ip);
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

function formatIp(n, family) {
  if (family === 4) return [24n, 16n, 8n, 0n].map(s => String((n >> s) & 255n)).join('.');
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return g.join(':');
}

function cidrRange(cidr, family) {
  const [ip, bitsRaw] = cidr.split('/');
  const total = BITS[family];
  const bits = bitsRaw === undefined ? total : Number(bitsRaw);
  const size = 1n << BigInt(total - bits);
  const start = (parseIp(ip, family) / size) * size;
  return [start, start + size - 1n];
}

// 給一組要排除的 CIDR，回傳剩下的連續範圍，格式是 netsh 吃的 "起-迄"
function complementRanges(cidrs, family) {
  const max = (1n << BigInt(BITS[family])) - 1n;
  const excl = cidrs.map(c => cidrRange(c, family)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  let cur = 0n;
  for (const [s, e] of excl) {
    if (s > cur) out.push([cur, s - 1n]);
    if (e + 1n > cur) cur = e + 1n;
  }
  if (cur <= max) out.push([cur, max]);
  return out.map(([s, e]) => `${formatIp(s, family)}-${formatIp(e, family)}`);
}

// 本機位址：除了 TUN 以外的全部（IPv6 全部都算，TUN 沒有 IPv6 位址）
const LOCAL_NOT_TUN = [...complementRanges([TUN_CIDR], 4), ...complementRanges([], 6)].join(',');
// 對方位址：公網
const REMOTE_PUBLIC = [...complementRanges(LOCAL_CIDRS_V4, 4), ...complementRanges(LOCAL_CIDRS_V6, 6)].join(',');

// ---- 要保護哪些程式（純函式）----
// 回傳 { paths: [完整路徑], names: [執行檔名] }；global 模式與純網域規則沒有程式可比對 → 空
/** @param {{ settings?: Record<string, any>, split?: Record<string, any> }} [opts] */
function protectedPrograms({ settings = {}, split = {} } = {}) {
  const names = new Set(); const paths = new Set();
  const add = (match, value) => {
    const vals = (Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\n,;]+/)).map(x => String(x).trim()).filter(Boolean);
    for (const v of vals) (match === 'path' ? paths : names).add(v);
  };
  if (settings.killSwitchScope === 'apps') {
    for (const n of settings.killSwitchApps || []) add('name', n);
  } else if ((split.mode || 'rule') === 'rule') {
    for (const r of split.rules || []) {
      if (!r || r.on === false || !r.target || r.target === 'direct') continue;
      const app = r.when && r.when.app;
      if (app && app.value) add(app.match === 'path' ? 'path' : 'name', app.value);
    }
  }
  return { paths: [...paths], names: [...names] };
}

// ---- 布防狀態機（平台無關；真正下指令的是 adapter）----
/**
 * @typedef {{ addRule(program: string): Promise<void>, removeAll(): Promise<void>, sameName(a: string, b: string): boolean, hasRules?(): Promise<boolean>, ruleName?: string }} FirewallAdapter
 * @typedef {{ adapter?: FirewallAdapter | null, listProcesses?: () => Array<{ path?: string }> | Promise<Array<{ path?: string }>>, log?: (level: string, msg: string) => void, basename?: (p: string) => string, rescanMs?: number }} FirewallOptions
 */
class KillSwitchFirewall {
  /** @param {FirewallOptions} [opts] */
  constructor({ adapter, listProcesses, log, basename, rescanMs = 60000 } = {}) {
    this.adapter = adapter || null;
    this.listProcesses = listProcesses || (async () => []);
    this.log = log || (() => {});
    this.basename = basename || (p => String(p).split(/[\\/]/).pop());
    this.rescanMs = rescanMs;
    this.armed = new Set();      // 已加過規則的完整路徑（小寫比對交給 adapter.sameName）
    this.targets = null;
    this.timer = null;
  }

  get supported() { return !!this.adapter; }
  get active() { return !!this.targets; }

  // 依新的目標清單布防（重複呼叫會先清掉舊的，因為規則表可能改了）
  async arm(targets) {
    if (!this.adapter) return { ok: false, unsupported: true };
    await this.disarm();
    this.targets = { paths: [...(targets.paths || [])], names: [...(targets.names || [])] };
    if (!this.targets.paths.length && !this.targets.names.length) { this.targets = null; return { ok: true, count: 0 }; }
    const n = await this.sync();
    if (this.targets && this.targets.names.length && this.rescanMs > 0) {
      this.timer = setInterval(() => { this.sync().catch(() => {}); }, this.rescanMs);
      if (this.timer.unref) this.timer.unref();
    }
    return { ok: true, count: n };
  }

  // 把還沒布防的程式補上：指定路徑的直接加；指定名稱的去執行中的程式找路徑
  async sync() {
    if (!this.adapter || !this.targets) return 0;
    const want = new Set(this.targets.paths);
    if (this.targets.names.length) {
      let procs = [];
      try { procs = (await this.listProcesses()) || []; } catch (e) {}
      for (const p of procs) {
        const full = p && p.path;
        if (!full) continue;
        const base = this.basename(full);
        if (this.targets.names.some(n => this.adapter.sameName(n, base))) want.add(full);
      }
    }
    let added = 0;
    for (const full of want) {
      if ([...this.armed].some(a => this.adapter.sameName(a, full))) continue;
      if (!this.targets) break;   // 途中被解除
      try {
        await this.adapter.addRule(full);
        this.armed.add(full);
        added++;
      } catch (e) { this.log('warn', `防火牆規則加不上：${full} — ${e.message}`); }
    }
    return added;
  }

  async disarm() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const had = this.armed.size > 0;
    this.targets = null;
    this.armed.clear();
    if (!this.adapter) return { ok: true };
    try { await this.adapter.removeAll(); }
    catch (e) { if (had) this.log('warn', `移除防火牆規則失敗：${e.message}`); return { ok: false, error: e.message }; }
    return { ok: true };
  }
}

// 逐一掛在 module.exports 上：.js 裡的 object literal 型別是「可擴充的」，
// 寫成 module.exports = { ... } 的話 npm run typecheck 抓不到呼叫端拼錯的名字。
module.exports.KillSwitchFirewall = KillSwitchFirewall;
module.exports.protectedPrograms = protectedPrograms;
module.exports.complementRanges = complementRanges;
module.exports.TUN_CIDR = TUN_CIDR;
module.exports.LOCAL_NOT_TUN = LOCAL_NOT_TUN;
module.exports.REMOTE_PUBLIC = REMOTE_PUBLIC;
