const { EventEmitter } = require('events');
const { spawn, execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const platformLayer = require('../platform');

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

// 內建「本機與內網 → 直連」保護規則的位址範圍。
//
// 為什麼需要：TUN 的 auto_route 會注入預設路由，內網流量一樣會進虛擬網卡。
// 只要預設走向指向代理，印表機 / NAS / 路由器管理頁 / mDNS 就會被送進 SOCKS 代理然後失敗。
// Proxifier 與 ProxyBridge 都內建同樣的保護（Proxifier 的 Localhost 規則就排在規則清單第一條）。
//
// 用寫死的 CIDR 而不是 geoip-private 規則庫：離線可用、零下載。
// 內容用 `sing-box rule-set match` 逐一驗過（含 mDNS 224.0.0.251；8.8.8.8 / 1.1.1.1 / 2001:db8::1 不命中）。
const PRIVATE_CIDRS = [
  '127.0.0.0/8',       // loopback
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', // RFC1918
  '169.254.0.0/16',    // link-local
  '100.64.0.0/10',     // CGNAT
  '224.0.0.0/4',       // multicast（含 mDNS / SSDP）
  '255.255.255.255/32',// broadcast
  '::1/128', 'fc00::/7', 'fe80::/10',
];

// 規則模擬器用的 IPv4 CIDR 判斷（IPv6 只做字面相等，實際分流仍以 sing-box 為準）
function cidrContains(cidr, ip) {
  const [net, bitsRaw] = String(cidr).split('/');
  if (!IPV4_RE.test(net) || !IPV4_RE.test(ip)) return String(net) === String(ip);
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = a => a.split('.').reduce((acc, o) => ((acc << 8) | (Number(o) & 255)) >>> 0, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(net) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0);
}

// Per-app 分流引擎：驅動打包的 sing-box，建立 TUN 虛擬網卡，依「程式規則」把指定程式的流量
// 導向對應的本地路由端口（127.0.0.1:localPort，由 RouteManager 服務），其餘依預設走向。
//
// 關鍵防迴圈：本 app 自己（含 RouteManager relay 對上游的連線）與 sing-box 一律 bypass（direct），
// 否則 relay → 上游 的連線會被 TUN 再抓一次造成迴圈。
class SingBoxEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    // 平台差異（執行檔名、TUN 介面命名、提權方式、收行程的方式）全部走 adapter，
    // 這裡不再出現任何 process.platform 判斷。測試可以注入任一平台的 adapter。
    this.platform = opts.platform || platformLayer.current;
    this.binPath = opts.binPath || this._resolveBin();
    this.configPath = path.join(os.tmpdir(), 'proxyclient-singbox.json');
    this.proc = null;
    this.state = 'off'; // off | starting | running
    this.tun = null;
    this.lastError = '';
  }

  _resolveBin() {
    // 打包後：resources/engine/<bin>；開發：<app>/engine/<bin>
    const bin = this.platform.engineBinName;
    const candidates = [
      process.resourcesPath && path.join(process.resourcesPath, 'engine', bin),
      path.join(__dirname, '..', '..', 'engine', bin),
    ].filter(Boolean);
    return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || candidates[candidates.length - 1];
  }

  isElevated() { return this.platform.isElevated(); }

  // 共用 TUN inbound（正常分流與斷線保護 block 模式都用同一張虛擬網卡設定）
  _tunInbound() {
    // macOS 的 utun 由核心命名、不能自訂 → adapter 回 null 時不寫 interface_name，交給 sing-box 配
    const name = this.platform.tunInterfaceName;
    return {
      type: 'tun', tag: 'tun-in',
      ...(name ? { interface_name: name } : {}),
      address: ['172.19.0.1/30'],
      mtu: 9000, auto_route: true, strict_route: false, stack: 'gvisor',
    };
  }

  // 依規則 + 路由產生 sing-box 設定
  //   rules        — 單一規則表，每條的 when 內各條件 AND（見 config.js 的 schema 2 說明）
  //   ruleSets     — 已安裝的規則庫 [{ tag, path, format }]（由 ruleset.js 提供）
  //   mode         — 'rule' 照規則表 | 'global' 全部走 globalTarget | 'direct' TUN 在但全部直連
  //   lanDirect    — 內建「本機與內網 → 直連」保護規則（三種模式都適用）
  generateConfig({ rules = [], ruleSets = [], defaultTarget = 'direct', udp = false, routes = [], selfNames = [],
                   mode = 'rule', globalTarget = null, lanDirect = true }) {
    const routeById = new Map(routes.map(r => [r.id, r]));
    const tagFor = target => (target === 'direct' || !routeById.has(target)) ? 'direct' : 'route-' + target;
    const setByTag = new Map((ruleSets || []).filter(s => s && s.tag && s.path).map(s => [s.tag, s]));
    // 只有規則模式才比對規則表；global / direct 模式整張表不參與（UI 端會把它降飽和）
    const active = mode === 'rule'
      ? (rules || []).filter(r => r && r.on !== false).map(r => this._normalizeRule(r, setByTag)).filter(Boolean)
      : [];
    const finalTarget = mode === 'global' ? globalTarget : mode === 'direct' ? 'direct' : defaultTarget;

    // 需要用到的路由 → 產生對應 outbound（socks/http 指向本地端口）
    const needed = new Set();
    for (const r of active) if (r.target !== 'direct' && r.target !== 'block' && routeById.has(r.target)) needed.add(r.target);
    if (finalTarget && finalTarget !== 'direct' && routeById.has(finalTarget)) needed.add(finalTarget);

    const outbounds = [{ type: 'direct', tag: 'direct' }];
    for (const id of needed) {
      const rt = routeById.get(id);
      outbounds.push({
        type: rt.kind === 'http' ? 'http' : 'socks',
        tag: 'route-' + id,
        server: '127.0.0.1',
        server_port: Number(rt.localPort),
        ...(rt.kind === 'http' ? {} : { version: '5' }),
      });
    }

    const routeRules = [];
    // 0) 網域類條件需要 sniff：TUN 只看得到目的地 IP，要靠嗅探 TLS SNI / HTTP Host 才有網域可比對。
    //    只有真的存在網域條件時才加，避免無謂的嗅探成本（純程式分流的設定與舊版逐字相同）。
    if (active.some(r => r.domainLike)) routeRules.push({ action: 'sniff' });
    // 1) 一律 bypass 自己與 sing-box，避免 relay→上游 的連線被 TUN 迴圈抓回
    const self = Array.from(new Set([...selfNames, ...this.platform.selfProcessNames].filter(Boolean)));
    if (self.length) routeRules.push({ process_name: self, outbound: 'direct' });

    // 1.5) 內建保護規則：本機與內網一律直連。排在使用者規則「之前」，
    //      否則任何較寬鬆的規則（例如「Chrome → 代理」）都會把 LAN 流量搶走。
    if (lanDirect) routeRules.push({ ip_cidr: [...PRIVATE_CIDRS], outbound: 'direct' });

    // 2) 規則表（先命中先贏，順序就是表的順序）
    for (const r of active) {
      routeRules.push({
        ...this._condObject(r.conds),
        ...(r.target === 'block' ? { action: 'reject' } : { outbound: tagFor(r.target) }),
      });
    }

    // 3) 只宣告真的被用到的規則庫；沒安裝的 tag 已在 _normalizeRule 濾掉（引用不存在的 tag 會 FATAL）
    const ruleSetDefs = this._ruleSetDefs(active, setByTag);

    // 4) route.rules 的索引 → 那一條是什麼。sing-box 的 debug log 印的 match[N] 就是這個索引，
    //    main.js 靠它把「命中第幾條」還原成使用者看得懂的規則。
    this.ruleIndex = [];
    let i = 0;
    if (active.some(r => r.domainLike)) this.ruleIndex[i++] = { kind: 'sniff' };
    if (self.length) this.ruleIndex[i++] = { kind: 'self' };
    if (lanDirect) this.ruleIndex[i++] = { kind: 'lan' };
    for (const r of active) this.ruleIndex[i++] = { kind: 'rule', id: r.id, target: r.target };

    return {
      // debug 才會印 `router: match[N] ... => ...`——命中標記與命中次數都靠它。
      // main.js 只解析不落地，避免把 app.log 灌爆。
      log: { level: 'debug', timestamp: true },
      inbounds: [this._tunInbound()],
      outbounds,
      route: {
        rules: routeRules,
        ...(ruleSetDefs.length ? { rule_set: ruleSetDefs } : {}),
        final: tagFor(finalTarget),
        auto_detect_interface: true,
      },
      // UDP：TUN 本身可帶 UDP；能否真的走取決於上游 SOCKS5 是否支援 UDP ASSOCIATE。
      // udp=false 時不特別阻擋（維持簡單），UI 端顯示提示。
      _udp: !!udp,
      _mode: mode,
    };
  }

  // 「換行 / 逗號 / 分號分隔的字串」或字串陣列 → 去空白、去重的陣列
  static values(v) {
    return Array.from(new Set(
      (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\n,;]+/))
        .map(x => String(x).trim()).filter(Boolean)
    ));
  }

  // 一條規則 → { conds: [sing-box 條件物件…], target, domainLike }
  // 所有條件是 AND；一個有效條件都湊不出來（值全空、或 ruleset 未下載）→ null，該規則整條略過。
  _normalizeRule(r, setByTag) {
    const when = r.when || {};
    const conds = [];
    let domainLike = false;

    // 誰在連
    const app = this._appCond(when.app);
    if (app) conds.push(app);

    // 連去哪
    const dest = this._destCond(when.dest, setByTag);
    if (dest) { conds.push(dest.cond); domainLike = domainLike || dest.domainLike; }
    else if (when.dest && when.dest.match) return null; // 有指定目的地條件卻湊不出來 → 整條略過，別讓它變成「命中所有流量」

    // 埠 / 協定
    const port = this._portCond(when.port);
    if (port) conds.push(port);
    const net = String(when.network || '').toLowerCase();
    if (net === 'tcp' || net === 'udp') conds.push({ network: [net] });

    if (!conds.length) return null; // 沒有任何條件的規則不該存在（要「全部」請用 defaultTarget）
    return { id: r.id, conds, target: r.target || 'direct', domainLike };
  }

  _appCond(app) {
    if (!app) return null;
    const vals = SingBoxEngine.values(app.value);
    if (!vals.length) return null;
    return app.match === 'path' ? { process_path: vals } : { process_name: vals };
  }

  _destCond(dest, setByTag) {
    if (!dest) return null;
    const vals = SingBoxEngine.values(dest.value);
    if (!vals.length) return null;
    switch (dest.match) {
      case 'domain': return { cond: { domain: vals }, domainLike: true };
      case 'suffix': {
        // UI 的「網域」種類：預設含子網域；開頭加 = 表示只要完全相符那一個網域。
        // sing-box 在同一條規則裡的 domain 與 domain_suffix 是 OR（實測驗證），所以可以同時給。
        const exact = vals.filter(v => v.startsWith('=')).map(v => v.slice(1).replace(/^\*?\./, '')).filter(Boolean);
        const suffix = vals.filter(v => !v.startsWith('=')).map(v => v.replace(/^\*?\./, '')).filter(Boolean);
        if (!exact.length && !suffix.length) return null;
        return {
          cond: { ...(exact.length ? { domain: exact } : {}), ...(suffix.length ? { domain_suffix: suffix } : {}) },
          domainLike: true,
        };
      }
      case 'keyword': return { cond: { domain_keyword: vals }, domainLike: true };
      case 'regex': return { cond: { domain_regex: vals }, domainLike: true };
      case 'ip': return { cond: { ip_cidr: vals.map(v => (v.includes('/') ? v : v + (v.includes(':') ? '/128' : '/32'))) }, domainLike: false };
      case 'ruleset': {
        const tags = vals.filter(t => setByTag.has(t));
        if (!tags.length) return null; // 規則庫尚未下載 → 略過，而不是讓 sing-box FATAL
        // geosite 類（網域規則庫）同樣需要 sniff 才比對得到
        return { cond: { rule_set: tags }, domainLike: tags.some(t => /^geosite/i.test(t)) };
      }
      default: return null;
    }
  }

  // '443, 8000-9000' → { port: [443], port_range: ['8000:9000'] }
  // sing-box 的 port_range 只吃冒號式，使用者習慣打的破折號要在這裡轉掉（打了 dash 會 FATAL）。
  _portCond(spec) {
    const ports = []; const ranges = [];
    for (const v of SingBoxEngine.values(spec)) {
      const m = v.match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (m) { ranges.push(`${m[1]}:${m[2]}`); continue; }
      if (/^\d+$/.test(v)) ports.push(Number(v));
    }
    if (!ports.length && !ranges.length) return null;
    return { ...(ports.length ? { port: ports } : {}), ...(ranges.length ? { port_range: ranges } : {}) };
  }

  // 單一條件 → 攤平（設定好讀）；多條件 → logical/and
  _condObject(conds) {
    return conds.length === 1 ? { ...conds[0] } : { type: 'logical', mode: 'and', rules: conds.map(c => ({ ...c })) };
  }

  _ruleSetDefs(active, setByTag) {
    const used = new Set();
    for (const r of active) for (const c of r.conds) for (const t of (c.rule_set || [])) used.add(t);
    return Array.from(used).map(t => {
      const s = setByTag.get(t);
      return { type: 'local', tag: t, format: s.format || (/\.srs$/i.test(s.path) ? 'binary' : 'source'), path: s.path };
    });
  }

  // 斷線保護（Kill-switch）專用設定：受保護程式（原本要走代理者）→ reject（fail-closed 丟棄），
  // 其餘程式 → direct（維持正常上網）。用 sing-box 內建 route action reject，不動防火牆。
  generateBlockConfig({ rules = [], ruleSets = [], selfNames = [], mode = 'rule', lanDirect = true }) {
    const routeRules = [];
    const setByTag = new Map((ruleSets || []).filter(s => s && s.tag && s.path).map(s => [s.tag, s]));
    // 只擋「原本要走代理」的規則（target 非 direct）；原本就直連的不動，使用者其餘上網照常。
    // 全域模式下本來所有流量都走代理 → 用一條 catch-all 擋掉全部；
    // 直連模式下本來就沒有任何流量走代理 → 沒有東西需要擋。
    const protectedRules = mode === 'rule'
      ? (rules || []).filter(r => r && r.on !== false && r.target !== 'direct')
          .map(r => this._normalizeRule(r, setByTag)).filter(Boolean)
      : [];
    if (protectedRules.some(r => r.domainLike)) routeRules.push({ action: 'sniff' });
    const self = Array.from(new Set([...selfNames, ...this.platform.selfProcessNames].filter(Boolean)));
    if (self.length) routeRules.push({ process_name: self, outbound: 'direct' });
    // 內網保護在封鎖模式同樣要放在最前面，否則 catch-all 會把使用者的內網也切斷
    if (lanDirect) routeRules.push({ ip_cidr: [...PRIVATE_CIDRS], outbound: 'direct' });
    for (const r of protectedRules) routeRules.push({ ...this._condObject(r.conds), action: 'reject' });
    if (mode === 'global') routeRules.push({ inbound: ['tun-in'], action: 'reject' });

    const ruleSetDefs = this._ruleSetDefs(protectedRules, setByTag);

    return {
      log: { level: 'warn', timestamp: true },  // 封鎖模式不需要命中資訊
      inbounds: [this._tunInbound()],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: {
        rules: routeRules,
        ...(ruleSetDefs.length ? { rule_set: ruleSetDefs } : {}),
        final: 'direct', auto_detect_interface: true,
      },
      _blocking: true,
    };
  }

  // ===== 規則模擬器（「這個網址會走哪一條？」）=====
  // 依和引擎完全相同的順序逐條比對，回傳第一個命中的規則。地區/網域規則庫用 sing-box 自己的
  // `rule-set match` 子命令判定（不需啟動 TUN、不需提權），所以結果與實際分流一致。
  async matchTarget({ host = '', exe = '', port = 0, network = 'tcp', rules = [], ruleSets = [], defaultTarget = 'direct' } = {}) {
    const setByTag = new Map((ruleSets || []).filter(s => s && s.tag && s.path).map(s => [s.tag, s]));
    const ctx = {
      dest: String(host).trim(),
      exe: String(exe || ''),
      exeName: String(exe || '').split(/[\\/]/).pop(), // 大小寫是否敏感由 adapter 的 appNameEquals 決定
      port: Number(port) || 0,
      network: String(network || 'tcp').toLowerCase(),
    };

    for (const r of (rules || []).filter(x => x && x.on !== false)) {
      const n = this._normalizeRule(r, setByTag);
      if (!n) continue;
      // 一條規則的所有條件必須全中（AND），和引擎的 logical/and 語意一致
      let all = true;
      for (const c of n.conds) {
        if (!(await this._condMatches(c, ctx, setByTag))) { all = false; break; }
      }
      if (all) {
        return {
          matched: true, by: this._ruleKind(n.conds), ruleId: r.id,
          ruleName: r.name || Object.keys(n.conds[0])[0], target: n.target,
          detail: n.conds.map(c => `${Object.keys(c)[0]}=${[].concat(Object.values(c)[0]).join('|')}`).join(' AND '),
        };
      }
    }
    return { matched: false, by: 'default', ruleId: null, ruleName: '其他所有流量', target: defaultTarget, detail: '' };
  }

  // 給 UI 標示命中的是哪種規則：只有程式條件 = app、只有目的地 = net、混用 = composite
  _ruleKind(conds) {
    const keys = conds.flatMap(c => Object.keys(c));
    const hasApp = keys.some(k => k.startsWith('process_'));
    const hasDest = keys.some(k => /^(domain|ip_cidr|rule_set)/.test(k));
    return hasApp && hasDest ? 'composite' : hasApp ? 'app' : 'net';
  }

  // 單一條件是否命中。ctx = { dest, exe, exeName, port, network }
  async _condMatches(cond, ctx, setByTag) {
    // 誰在連
    if (cond.process_name) return !!ctx.exeName && cond.process_name.some(n => this.platform.appNameEquals(n, ctx.exeName));
    if (cond.process_path) return !!ctx.exe && cond.process_path.some(p => this.platform.appNameEquals(p, ctx.exe));
    // 埠 / 協定
    if (cond.port || cond.port_range) {
      if (!ctx.port) return false;
      if ((cond.port || []).includes(ctx.port)) return true;
      return (cond.port_range || []).some(r => {
        const [lo, hi] = String(r).split(':').map(Number);
        return ctx.port >= lo && ctx.port <= hi;
      });
    }
    if (cond.network) return cond.network.includes(ctx.network);
    // 連去哪（沒有輸入目的地就無從判斷 → 不算命中）
    const value = ctx.dest;
    if (!value) return false;
    const isIp = IPV4_RE.test(value) || value.includes(':');
    const host = value.toLowerCase();
    // domain 與 domain_suffix 在同一條規則裡是 OR（與 sing-box 一致）
    if (cond.domain || cond.domain_suffix) {
      if ((cond.domain || []).some(d => d.toLowerCase() === host)) return true;
      return (cond.domain_suffix || []).some(s => { const t = s.toLowerCase().replace(/^\./, ''); return host === t || host.endsWith('.' + t); });
    }
    if (cond.domain_keyword) return cond.domain_keyword.some(k => host.includes(k.toLowerCase()));
    if (cond.domain_regex) return cond.domain_regex.some(rx => { try { return new RegExp(rx).test(value); } catch (e) { return false; } });
    if (cond.ip_cidr) return isIp && cond.ip_cidr.some(c => cidrContains(c, value));
    if (cond.rule_set) {
      for (const tag of cond.rule_set) {
        const s = setByTag.get(tag);
        if (!s) continue;
        if (await this._ruleSetMatch(s, value)) return true;
      }
    }
    return false;
  }

  async _ruleSetMatch(set, value) {
    try {
      const fmt = set.format || (/\.srs$/i.test(set.path) ? 'binary' : 'source');
      // sing-box 把命中結果印在 stderr（不是 stdout），兩邊都要看
      const { stdout, stderr } = await execFileP(this.binPath, ['rule-set', 'match', set.path, '-f', fmt, value], { windowsHide: true, timeout: 8000 });
      return /match rules?\./i.test(String(stdout || '') + String(stderr || ''));
    } catch (e) { return false; }
  }

  // 內部欄位（以底線開頭，如 _blocking / _udp）只給 app 自己判斷用，
  // 絕不能寫進 sing-box 設定——sing-box 對未知欄位會直接 FATAL（kill-switch 失效的元兇）。
  _forEngine(cfg) {
    const c = { ...cfg };
    for (const k of Object.keys(c)) if (k.startsWith('_')) delete c[k];
    return c;
  }

  // 只驗證設定是否合法（sing-box check），不啟動 TUN，不需提權
  async validate(cfgObj) {
    const tmp = path.join(os.tmpdir(), 'proxyclient-singbox-check.json');
    const clean = this._forEngine(cfgObj);
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
    try { await execFileP(this.binPath, ['check', '-c', tmp], { windowsHide: true }); return { ok: true }; }
    catch (e) { return { ok: false, error: (e.stderr || e.stdout || e.message || '').toString().trim() }; }
  }

  async start(params) {
    this._blocking = false;
    return this._launch(this.generateConfig(params));
  }

  // 斷線保護：引擎異常中止時，以 block 設定重啟 TUN，讓受保護程式 fail-closed（其餘 direct）。
  async startBlock(params) {
    this._blocking = true;
    return this._launch(this.generateBlockConfig(params));
  }

  async _launch(cfg) {
    if (this.state === 'running' || this.state === 'starting') return { ok: true };
    if (!fs.existsSync(this.binPath)) return { ok: false, error: 'sing-box 未安裝（找不到執行檔）' };

    const check = await this.validate(cfg);
    if (!check.ok) { this.lastError = check.error; return { ok: false, error: '設定無效：' + check.error }; }

    if (!this.isElevated()) {
      // TUN 需要系統管理員權限；請 UI 顯示 UAC 說明並提權（app 以系管員重啟）
      return { ok: false, needElevation: true, message: '建立 TUN 虛擬網卡與設定路由表需要系統管理員權限。' };
    }

    this._userStopping = false;
    this.lastError = ''; // 清掉上次啟動殘留的 FATAL，避免這次啟動被誤判失敗
    // 清掉可能殘留、占用同名 TUN 介面的舊 sing-box（上次崩潰未清乾淨 → "file already exists"）。
    // 只有需要這一步的平台（目前是 Windows）才回傳指令；mac/Linux 的 TUN 介面由核心回收。
    const cleanup = !this.proc && this.platform.staleEngineCleanupCommand(this.binPath);
    if (cleanup) {
      try { await execFileP(cleanup.cmd, cleanup.args, { windowsHide: true, timeout: 4000 }); } catch (e) {}
      await new Promise(r => setTimeout(r, 300));
    }
    const clean = this._forEngine(cfg);
    fs.writeFileSync(this.configPath, JSON.stringify(clean, null, 2));

    this._setState('starting');
    return await new Promise(resolve => {
      let settled = false;
      const done = r => { if (!settled) { settled = true; resolve(r); } };
      try {
        this.proc = spawn(this.binPath, ['run', '-c', this.configPath], { windowsHide: true });
      } catch (e) { this._setState('off'); return done({ ok: false, error: e.message }); }

      const onData = buf => {
        const s = buf.toString();
        this.emit('log', s);
        if (/started|sing-box.*run|tun.*started|inbound\/tun/i.test(s)) {
          this.tun = 'proxyclient-tun';
          this._setState('running');
          done({ ok: true });
        }
        if (/FATAL|panic|permission denied|access is denied/i.test(s)) {
          this.lastError = s.trim();
          done({ ok: false, error: s.trim() }); // FATAL → 立刻回報失敗，別讓 2.5s 計時器誤判成功（kill-switch 誤報「已保護」）
        }
      };
      this.proc.stdout && this.proc.stdout.on('data', onData);
      this.proc.stderr && this.proc.stderr.on('data', onData);
      this.proc.on('exit', code => {
        this.proc = null; this.tun = null;
        const wasRunning = this.state === 'running';
        this._setState('off');
        if (!settled) done({ ok: false, error: this.lastError || `sing-box 結束（code ${code}）` });
        else if (wasRunning && !this._userStopping) this.emit('exit', code); // 非使用者主動停止 = 異常中止
      });
      // 保險：TUN 啟動後 sing-box 通常持續執行且不一定印明確 "started"；2.5s 內沒 exit 就當成功
      setTimeout(() => {
        if (this.proc && !settled) {
          if (this.lastError && /FATAL|panic/i.test(this.lastError)) { done({ ok: false, error: this.lastError }); return; } // 已見 FATAL → 別假設成功
          this.tun = 'proxyclient-tun'; this._setState('running'); done({ ok: true });
        }
      }, 2500);
    });
  }

  async stop() {
    this._userStopping = true; // 標記為使用者主動停止 → exit 不觸發斷線保護
    if (this.proc) {
      // 先禮貌後強制：讓 sing-box 有機會移除 TUN 網卡與系統路由，逾時再殺，避免殘留把網路卡住。
      await this.platform.killTree(this.proc.pid, this.proc);
      this.proc = null;
    }
    this.tun = null;
    this._setState('off');
    return { ok: true };
  }

  status() {
    const elevated = this.isElevated();
    return {
      state: this.state,
      elevated,
      blocking: !!this._blocking && this.state === 'running',
      tun: this.tun,
      health: [
        { label: '分流引擎', value: this.state === 'running' ? '執行中' : this.state === 'starting' ? '啟動中' : '未執行', dot: this.state === 'running' ? 'var(--good)' : this.state === 'starting' ? 'var(--amber)' : 'var(--text3)' },
        { label: '虛擬網卡 (TUN)', value: this.tun || '未建立', dot: this.tun ? 'var(--good)' : 'var(--text3)' },
        { label: '提權狀態', value: elevated ? '已授權' : '未授權', dot: elevated ? 'var(--good)' : 'var(--amber)' },
        { label: 'sing-box', value: fs.existsSync(this.binPath) ? '已就緒' : '未安裝', dot: fs.existsSync(this.binPath) ? 'var(--good)' : 'var(--red)' },
      ],
    };
  }

  _setState(s) { if (this.state !== s) { this.state = s; this.emit('status', this.status()); } }
}

module.exports = SingBoxEngine;
