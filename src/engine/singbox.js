const { EventEmitter } = require('events');
const { spawn, execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');

// Per-app 分流引擎：驅動打包的 sing-box，建立 TUN 虛擬網卡，依「程式規則」把指定程式的流量
// 導向對應的本地路由端口（127.0.0.1:localPort，由 RouteManager 服務），其餘依預設走向。
//
// 關鍵防迴圈：本 app 自己（含 RouteManager relay 對上游的連線）與 sing-box 一律 bypass（direct），
// 否則 relay → 上游 的連線會被 TUN 再抓一次造成迴圈。
class SingBoxEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.binPath = opts.binPath || this._resolveBin();
    this.configPath = path.join(os.tmpdir(), 'proxyclient-singbox.json');
    this.proc = null;
    this.state = 'off'; // off | starting | running
    this.tun = null;
    this.lastError = '';
  }

  _resolveBin() {
    // 打包後：resources/engine/sing-box.exe；開發：<app>/engine/sing-box.exe
    const candidates = [
      process.resourcesPath && path.join(process.resourcesPath, 'engine', 'sing-box.exe'),
      path.join(__dirname, '..', '..', 'engine', 'sing-box.exe'),
    ].filter(Boolean);
    return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || candidates[candidates.length - 1];
  }

  isElevated() {
    if (process.platform !== 'win32') return true;
    try { execSync('net session', { stdio: 'ignore', windowsHide: true }); return true; }
    catch (e) { return false; }
  }

  // 共用 TUN inbound（正常分流與斷線保護 block 模式都用同一張虛擬網卡設定）
  _tunInbound() {
    return {
      type: 'tun', tag: 'tun-in',
      interface_name: 'proxyclient-tun',
      address: ['172.19.0.1/30'],
      mtu: 9000, auto_route: true, strict_route: false, stack: 'gvisor',
    };
  }

  // 依規則 + 路由產生 sing-box 設定
  generateConfig({ rules = [], defaultTarget = 'direct', udp = false, routes = [], selfNames = [] }) {
    const routeById = new Map(routes.map(r => [r.id, r]));
    const tagFor = target => (target === 'direct' || !routeById.has(target)) ? 'direct' : 'route-' + target;

    // 需要用到的路由 → 產生對應 outbound（socks/http 指向本地端口）
    const needed = new Set();
    for (const r of rules) if (r.on && r.target !== 'direct' && routeById.has(r.target)) needed.add(r.target);
    if (defaultTarget !== 'direct' && routeById.has(defaultTarget)) needed.add(defaultTarget);

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
    // 1) 一律 bypass 自己與 sing-box，避免 relay→上游 的連線被 TUN 迴圈抓回
    const self = Array.from(new Set([...selfNames, 'sing-box.exe'].filter(Boolean)));
    if (self.length) routeRules.push({ process_name: self, outbound: 'direct' });
    // 2) 逐條 app 規則
    for (const r of rules) {
      if (!r.on) continue;
      const ob = tagFor(r.target);
      if (r.match === 'path' && r.path) routeRules.push({ process_path: [r.path], outbound: ob });
      else if (r.exe) routeRules.push({ process_name: [r.exe], outbound: ob });
    }

    return {
      log: { level: 'warn', timestamp: true },
      inbounds: [this._tunInbound()],
      outbounds,
      route: {
        rules: routeRules,
        final: tagFor(defaultTarget),
        auto_detect_interface: true,
      },
      // UDP：TUN 本身可帶 UDP；能否真的走取決於上游 SOCKS5 是否支援 UDP ASSOCIATE。
      // udp=false 時不特別阻擋（維持簡單），UI 端顯示提示。
      _udp: !!udp,
    };
  }

  // 斷線保護（Kill-switch）專用設定：受保護程式（原本要走代理者）→ reject（fail-closed 丟棄），
  // 其餘程式 → direct（維持正常上網）。用 sing-box 內建 route action reject，不動防火牆。
  generateBlockConfig({ rules = [], selfNames = [] }) {
    const routeRules = [];
    const self = Array.from(new Set([...selfNames, 'sing-box.exe'].filter(Boolean)));
    if (self.length) routeRules.push({ process_name: self, outbound: 'direct' });
    for (const r of rules) {
      if (!r.on || r.target === 'direct') continue; // 只擋原本要走代理的程式，其餘不動
      if (r.match === 'path' && r.path) routeRules.push({ process_path: [r.path], action: 'reject' });
      else if (r.exe) routeRules.push({ process_name: [r.exe], action: 'reject' });
    }
    return {
      log: { level: 'warn', timestamp: true },
      inbounds: [this._tunInbound()],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { rules: routeRules, final: 'direct', auto_detect_interface: true },
      _blocking: true,
    };
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
    // 清掉可能殘留、占用同名 TUN 介面的舊 sing-box（上次崩潰未清乾淨 → "file already exists"）
    if (process.platform === 'win32' && !this.proc) {
      // 只清掉「從本 app 這支 sing-box.exe 啟動、且殘留占住同名 TUN」的行程；
      // 不用 taskkill /IM sing-box.exe（那會把別的 sing-box 系 app 一起殺）。
      try {
        const self = String(this.binPath).replace(/'/g, "''");
        const ps = `Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" | Where-Object { $_.ExecutablePath -eq '${self}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        await execFileP('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 4000 });
      } catch (e) {}
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
      const pid = this.proc.pid;
      // 先嘗試優雅終止（讓 sing-box 有機會移除 TUN 網卡與系統路由），逾時再強制，避免殘留把網路卡住。
      try { await execFileP('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, timeout: 3000 }); } catch (e) {}
      await new Promise(r => setTimeout(r, 1200));
      try { if (this.proc) this.proc.kill(); } catch (e) {}
      try { await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }); } catch (e) {}
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
