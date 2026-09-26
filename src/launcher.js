// 實例分流（設計稿 v5「以路由啟動程式」）。
//
// 兩種模式，語意刻意不同：
//   browser — 用啟動參數把瀏覽器綁到某條路由的本地埠，開獨立 profile。
//             只有這個視窗走代理，免 TUN、免提權，關掉視窗就結束。這條是真的「只有這次」。
//   program — 其他程式沒有通用的「用這個代理」啟動參數，只能靠分流引擎依程序比對。
//             但 sing-box 比的是 process_name / process_path，**沒有 PID 級別的規則**，
//             所以做不到「只有這次啟動的那個程序」——登記下去就是那支程式一律走該路由。
//             設計稿寫的是「只管這次啟動的程序與其子程序」，引擎給不了，文案照實寫。
//
// 這裡只管「我們啟動的東西」的生命週期；規則本身還是存在 split.rules 裡。

const { spawn } = require('child_process');

class Launcher {
  // deps：{ platform, userDataDir, mkdirp, log, onChange }
  constructor(deps = {}) {
    this.platform = deps.platform;
    // 路徑語意跟著 adapter 走，不跟著執行主機。
    // 不然在 Linux 上跑 Windows adapter 時，basename('C:\x\a.exe') 會回整串。
    this.path = (deps.platform && deps.platform.path) || require('path');
    this.userDataDir = deps.userDataDir || '';
    this.mkdirp = deps.mkdirp || (() => {});
    this.log = deps.log || (() => {});
    this.onChange = deps.onChange || (() => {});
    this.instances = new Map();   // id → { id, name, exe, mode, routeId, pid, profile, startedAt }
    this._seq = 0;
  }

  // 目錄裡真的找得到的瀏覽器（同名只留第一個命中的路徑）
  browsers() {
    const seen = new Map();
    for (const c of this.platform.browserCandidates()) {
      if (seen.has(c.name)) continue;
      if (this._exists(c.path)) seen.set(c.name, { name: c.name, path: c.path, found: true });
    }
    // 目錄裡出現過但沒安裝的，也要回報（UI 要顯示「未安裝」而不是整個不見）
    for (const c of this.platform.browserCandidates()) {
      if (!seen.has(c.name)) seen.set(c.name, { name: c.name, path: c.path, found: false });
    }
    return Array.from(seen.values());
  }

  _exists(p) { try { return require('fs').existsSync(p); } catch (e) { return false; } }

  _splitArgs(s) {
    const args = []; let cur = ''; let inQ = false;
    for (const ch of s) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ' ' && !inQ) { if (cur) args.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur) args.push(cur);
    return args;
  }

  profileDir(routeId) {
    return this.path.join(this.userDataDir, 'browser-profiles', String(routeId).replace(/[^\w.-]/g, '_'));
  }

  // 瀏覽器的啟動參數。抽出來是為了讓「將執行」預覽與實際啟動用同一份，不會對不上。
  browserArgs({ route, localPort, profile = true, dnsGuard = true }) {
    const scheme = route.kind === 'http' ? 'http' : 'socks5';
    const args = [`--proxy-server=${scheme}://127.0.0.1:${localPort}`];
    if (profile) args.push(`--user-data-dir=${this.profileDir(route.id)}`);
    if (dnsGuard) {
      // host-resolver-rules：不讓瀏覽器用系統 DNS，否則連線走代理但查詢仍從真實 IP 出去。
      //   EXCLUDE 127.0.0.1 是必要的，不然連本地中繼自己都解析不到。
      // force-webrtc-ip-handling-policy：擋掉 WebRTC 的非代理 UDP，那是洩漏真實 IP 最經典的一條路。
      args.push('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
      args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }
    args.push('--no-first-run', '--no-default-browser-check', 'about:blank');
    return args;
  }

  // UI 的「將執行」那一段。回傳字串，和 browserArgs 同源。
  preview({ mode, route, localPort, browserName, exePath, exeArgs, profile = true, dnsGuard = true }) {
    if (mode === 'browser') {
      if (!browserName) return '（尚未選擇瀏覽器)';
      const b = this.browsers().find(x => x.name === browserName);
      const exe = b ? this.path.basename(b.path) : browserName;
      return [exe, ...this.browserArgs({ route, localPort, profile, dnsGuard })].join(' ');
    }
    if (!exePath) return '（尚未選擇程式）';
    return `${exePath}${exeArgs ? ' ' + exeArgs : ''}\n→ 登記程式規則：${this.path.basename(exePath)} → ${route.label || route.id}`;
  }

  launchBrowser({ route, localPort, browserName, profile = true, dnsGuard = true }) {
    const list = this.browsers();
    const b = browserName ? list.find(x => x.name === browserName && x.found) : list.find(x => x.found);
    if (!b) return { ok: false, error: browserName ? `找不到 ${browserName}` : '找不到 Chrome / Edge，請確認已安裝' };
    if (profile) { try { this.mkdirp(this.profileDir(route.id)); } catch (e) {} }
    const args = this.browserArgs({ route, localPort, profile, dnsGuard });
    let child;
    try { child = spawn(b.path, args, { detached: true, stdio: 'ignore', windowsHide: false }); }
    catch (e) { return { ok: false, error: e.message }; }
    child.on('error', () => {});
    child.unref();
    const inst = this._add({ name: b.name, exe: this.path.basename(b.path), mode: 'browser', routeId: route.id, pid: child.pid, profile: profile ? route.id : null });
    this.log('info', 'launch', `用路由「${route.label || route.id}」開啟 ${b.name}`, `127.0.0.1:${localPort} · PID ${child.pid}`);
    return { ok: true, instance: inst, browser: b.name };
  }

  launchProgram({ route, exePath, exeArgs }) {
    if (!exePath) return { ok: false, error: '請先選擇程式' };
    const argv = String(exeArgs || '').trim();
    let child;
    try {
      child = spawn(exePath, argv ? this._splitArgs(argv) : [], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (e) { return { ok: false, error: e.message }; }
    child.on('error', () => {});
    child.unref();
    const name = this.path.basename(exePath).replace(/\.exe$/i, '');
    const inst = this._add({ name, exe: this.path.basename(exePath), mode: 'engine', routeId: route.id, pid: child.pid, exePath });
    this.log('info', 'launch', `用路由「${route.label || route.id}」啟動 ${name}`, `PID ${child.pid}`);
    return { ok: true, instance: inst };
  }

  _add(data) {
    const id = 'i' + (++this._seq) + '-' + Date.now();
    const inst = { id, startedAt: Date.now(), ...data };
    this.instances.set(id, inst);
    this._watch(inst);
    this.onChange(this.list());
    return inst;
  }

  // 程序沒了就把列拿掉。用輕量的存活檢查，不常駐 handle。
  _watch(inst) {
    const tick = () => {
      if (!this.instances.has(inst.id)) return;
      if (!this._alive(inst.pid)) { this.instances.delete(inst.id); this.onChange(this.list()); return; }
      setTimeout(tick, 3000).unref?.();
    };
    setTimeout(tick, 3000).unref?.();
  }

  _alive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }   // EPERM = 還在，只是沒權限
  }

  list() { return Array.from(this.instances.values()); }

  async kill(id) {
    const inst = this.instances.get(id);
    if (!inst) return { ok: false, error: '找不到這個實例' };
    try { await this.platform.killTree(inst.pid); } catch (e) { /* 已經自己結束了 */ }
    this.instances.delete(id);
    this.onChange(this.list());
    this.log('info', 'launch', `已結束 ${inst.name}`, `PID ${inst.pid}`);
    return { ok: true };
  }

  async killAll() { for (const id of Array.from(this.instances.keys())) await this.kill(id); }
}

module.exports = { Launcher };
