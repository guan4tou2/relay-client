const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');

// 規則庫（rule-set）管理：依網域 / 地區(GeoIP) 分流所需的資料來源。
//
// sing-box 1.12 起已移除舊的 geoip/geosite 資料庫，改用 rule-set（.srs 二進位 或 .json 原始碼）。
// 本模組負責：內建目錄（catalog）→ 下載 / 匯入 / 更新 / 刪除 → 交給 singbox.js 以 type:"local" 引用。
//
// 設計原則：
//   • 預設完全離線——只有使用者按下「下載」才會連網，且來源網域寫死（allowlist），不吃外部輸入的網址。
//   • 下載可指定「經由某條路由」（chain hops），讓 GitHub 被擋的環境也能取得規則庫。
//   • 中繼資料存 <dir>/index.json（不碰 electron-store），檔案存 <dir>/<tag>.srs|.json。

const GEOIP_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/';
const GEOSITE_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/';
// 下載來源白名單：任何不在此清單的 host 一律拒絕（避免規則庫來源被竄改成任意網址）
const ALLOWED_HOSTS = ['raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com'];
const MAX_BYTES = 32 * 1024 * 1024; // 單一規則庫上限 32 MB，避免無上限下載
const REDIRECT_MAX = 5;

const geoip = (code, label, note) => ({ tag: 'geoip-' + code, kind: 'geoip', code, label, note, url: GEOIP_BASE + 'geoip-' + code + '.srs' });
const geosite = (code, label, note) => ({ tag: 'geosite-' + code, kind: 'geosite', code, label, note, url: GEOSITE_BASE + 'geosite-' + code + '.srs' });

// 內建目錄：常用地區（GeoIP）與網站分類（GeoSite）。使用者也可自行匯入 .srs / .json。
const CATALOG = [
  geoip('tw', '台灣 IP', '目的地 IP 屬於台灣'),
  geoip('cn', '中國 IP', '目的地 IP 屬於中國大陸'),
  geoip('jp', '日本 IP', '目的地 IP 屬於日本'),
  geoip('hk', '香港 IP', '目的地 IP 屬於香港'),
  geoip('kr', '韓國 IP', '目的地 IP 屬於韓國'),
  geoip('sg', '新加坡 IP', '目的地 IP 屬於新加坡'),
  geoip('us', '美國 IP', '目的地 IP 屬於美國'),
  geoip('private', '私有 / 內網 IP', 'RFC1918 等內網位址，通常設為直連'),
  geosite('cn', '中國網站', '中國大陸常見網域'),
  geosite('geolocation-!cn', '非中國網站', '中國大陸以外的網域'),
  geosite('google', 'Google', 'Google 系服務網域'),
  geosite('github', 'GitHub', 'GitHub 與相關網域'),
  geosite('openai', 'OpenAI', 'ChatGPT / OpenAI 網域'),
  geosite('netflix', 'Netflix', 'Netflix 串流網域'),
  geosite('youtube', 'YouTube', 'YouTube 網域'),
  geosite('telegram', 'Telegram', 'Telegram 網域'),
  geosite('twitter', 'X / Twitter', 'X（原 Twitter）網域'),
  geosite('apple', 'Apple', 'Apple 服務網域'),
  geosite('microsoft', 'Microsoft', 'Microsoft 服務網域'),
  geosite('steam', 'Steam', 'Steam 平台網域'),
  geosite('category-ads-all', '廣告 / 追蹤器', '常與「封鎖」搭配使用'),
];

const isSrs = f => /\.srs$/i.test(f);
const fmtOf = f => (isSrs(f) ? 'binary' : 'source');
// tag 會直接寫進 sing-box 設定並用來組檔名 → 只允許安全字元，擋掉路徑穿越
const safeTag = t => /^[A-Za-z0-9!_.-]{1,64}$/.test(String(t || ''));

// 先寫暫存檔再 rename：直接覆寫的話，磁碟滿或寫到一半失敗會留下一個壞掉的 .srs，
// index 還指著它，下次啟動 sing-box 直接 FATAL。rename 在同一個目錄裡是原子的。
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (err) {}
    throw e;
  }
}

class RuleSetStore {
  constructor(opts = {}) {
    this.dir = opts.dir;
    this.httpsGet = opts.httpsGet || ((o, cb) => https.get(o, cb));
    this.connectChain = opts.connectChain || null; // (hops, {host,port}) => Promise<socket>，供「經由路由下載」
  }

  catalog() { return CATALOG.map(c => ({ ...c })); }

  _indexPath() { return path.join(this.dir, 'index.json'); }

  _readIndex() {
    try {
      const arr = JSON.parse(fs.readFileSync(this._indexPath(), 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  _writeIndex(list) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this._indexPath(), JSON.stringify(list, null, 2));
    return list;
  }

  // 已安裝清單；檔案被手動刪掉的條目標記 missing（UI 顯示為需重新下載，不直接丟給引擎）
  list() {
    return this._readIndex().map(e => {
      const file = path.join(this.dir, e.file);
      return { ...e, path: file, format: fmtOf(e.file), missing: !fs.existsSync(file) };
    });
  }

  get(tag) { return this.list().find(e => e.tag === tag) || null; }

  // 交給 singbox.js 的形狀：只回傳檔案還在的，避免 sing-box 因找不到檔案 FATAL
  resolveForEngine(tags) {
    const want = new Set((tags || []).filter(Boolean));
    return this.list()
      .filter(e => want.has(e.tag) && !e.missing)
      .map(e => ({ tag: e.tag, path: e.path, format: e.format }));
  }

  async install(tag, opts = {}) {
    const item = CATALOG.find(c => c.tag === tag);
    if (!item) return { ok: false, error: '目錄中沒有這個規則庫：' + tag };
    return this._fetchInto(item, opts);
  }

  async update(tag, opts = {}) {
    const cur = this.get(tag);
    if (!cur) return { ok: false, error: '尚未安裝：' + tag };
    if (cur.source === 'import') return { ok: false, error: '手動匯入的規則庫沒有更新來源，請重新匯入檔案。' };
    const item = CATALOG.find(c => c.tag === tag) || { tag: cur.tag, kind: cur.kind, label: cur.label, url: cur.url };
    return this._fetchInto(item, opts);
  }

  async updateAll(opts = {}) {
    const results = [];
    for (const e of this.list()) {
      if (e.source === 'import') continue;
      results.push({ tag: e.tag, ...(await this.update(e.tag, opts)) });
    }
    return results;
  }

  async _fetchInto(item, opts) {
    if (!safeTag(item.tag)) return { ok: false, error: '規則庫代號不合法' };
    let buf;
    try { buf = await this._download(item.url, opts); }
    catch (e) { return { ok: false, error: e.message }; }

    const file = item.tag + (isSrs(item.url) ? '.srs' : '.json');
    if (!buf || !buf.length) return { ok: false, error: '下載到的規則庫是空的' };
    if (!isSrs(file)) { try { JSON.parse(buf.toString('utf8')); } catch (e) { return { ok: false, error: '下載到的 .json 規則庫格式錯誤：' + e.message }; } }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeFileAtomic(path.join(this.dir, file), buf);
    } catch (e) { return { ok: false, error: '寫入規則庫失敗：' + e.message }; }

    const rec = {
      tag: item.tag, kind: item.kind, label: item.label || item.tag, url: item.url,
      file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      updatedAt: Date.now(), source: 'catalog',
    };
    const list = this._readIndex().filter(e => e.tag !== item.tag);
    list.push(rec);
    this._writeIndex(list);
    return { ok: true, entry: { ...rec, path: path.join(this.dir, file), format: fmtOf(file) } };
  }

  // 匯入本機 .srs / .json（完全離線的路徑：使用者自備規則庫）
  importFile(srcPath, meta = {}) {
    try {
      if (!fs.existsSync(srcPath)) return { ok: false, error: '找不到檔案：' + srcPath };
      const ext = path.extname(srcPath).toLowerCase();
      if (ext !== '.srs' && ext !== '.json') return { ok: false, error: '只支援 .srs（二進位）或 .json（原始碼）規則庫' };
      const tag = meta.tag || path.basename(srcPath, ext);
      if (!safeTag(tag)) return { ok: false, error: '規則庫代號只能使用英數字與 - _ . !（1–64 字）' };
      const buf = fs.readFileSync(srcPath);
      if (buf.length > MAX_BYTES) return { ok: false, error: '規則庫檔案過大（上限 32 MB）' };
      if (ext === '.json') { try { JSON.parse(buf.toString('utf8')); } catch (e) { return { ok: false, error: '.json 規則庫格式錯誤：' + e.message }; } }

      const file = tag + ext;
      fs.mkdirSync(this.dir, { recursive: true });
      writeFileAtomic(path.join(this.dir, file), buf);
      const rec = {
        tag, kind: meta.kind || (/^geoip/i.test(tag) ? 'geoip' : 'geosite'), label: meta.label || tag,
        url: '', file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        updatedAt: Date.now(), source: 'import',
      };
      const list = this._readIndex().filter(e => e.tag !== tag);
      list.push(rec);
      this._writeIndex(list);
      return { ok: true, entry: { ...rec, path: path.join(this.dir, file), format: fmtOf(file) } };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  remove(tag) {
    const e = this._readIndex().find(x => x.tag === tag);
    if (e) { try { fs.unlinkSync(path.join(this.dir, e.file)); } catch (err) {} }
    this._writeIndex(this._readIndex().filter(x => x.tag !== tag));
    return { ok: true };
  }

  // ---- 下載（GET + 有限次數 redirect；可經由路由的 chain hops）----
  _download(url, opts = {}, depth = 0) {
    return new Promise((resolve, reject) => {
      if (depth > REDIRECT_MAX) return reject(new Error('重新導向次數過多'));
      let u;
      try { u = new URL(url); } catch (e) { return reject(new Error('網址不合法')); }
      if (u.protocol !== 'https:') return reject(new Error('規則庫只接受 https 來源'));
      if (!ALLOWED_HOSTS.includes(u.hostname)) return reject(new Error('不允許的下載來源：' + u.hostname));

      const req = this.httpsGet({
        hostname: u.hostname, path: u.pathname + u.search, port: 443,
        headers: { 'User-Agent': 'RelayClient', Accept: '*/*' },
        timeout: opts.timeout || 30000,
        // 經由路由下載：用既有的 connectViaChain 建通道，再在上面跑 TLS。
        // 給了 createConnection 又沒給 agent 時，https 模組會直接拿這個 socket 送請求、不會自己包 TLS ——
        // 以前就是這樣，送到 443 的是明文 GET，經由路由下載從來沒成功過。
        ...(opts.hops && opts.hops.length && this.connectChain
          ? { createConnection: (o, cb) => {
              // 憑證驗證照預設（rejectUnauthorized: true）；失敗會以 'error' 傳到 req
              this.connectChain(opts.hops, { host: u.hostname, port: 443 })
                .then(raw => cb(null, tls.connect({ socket: raw, servername: u.hostname, ALPNProtocols: ['http/1.1'] })), cb);
            } }
          : {}),
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return this._download(new URL(res.headers.location, u).toString(), opts, depth + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('下載失敗（HTTP ' + res.statusCode + '）')); }
        const chunks = []; let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > MAX_BYTES) { req.destroy(); return reject(new Error('規則庫檔案過大（上限 32 MB）')); }
          chunks.push(c);
          if (opts.onProgress) opts.onProgress(size);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(new Error('下載逾時')); });
      req.on('error', e => reject(new Error('下載失敗：' + e.message)));
    });
  }
}

module.exports = { RuleSetStore, CATALOG, GEOIP_BASE, GEOSITE_BASE, ALLOWED_HOSTS };
