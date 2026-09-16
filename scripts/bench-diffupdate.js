// 差分更新到底有沒有生效？用「網卡實際收了多少位元組」來量。
//
// electron-updater 在有 current.blockmap（目前已安裝那版的區塊指紋）時，
// 會拿它跟新版的 blockmap 比對，只抓變動的區塊；沒有的話就整包重抓。
// 我們自己在 v1.3.5 把那個檔當殘留刪掉過，所以這件事必須實測，不能靠推論。
//
// 量法：下載前後各讀一次網卡累計收到的位元組。機器上其他流量會混進來，
// 但「幾 MB」跟「七十幾 MB」的差距遠大於那點雜訊。
//
//   CDP_PORT=9302 node scripts/bench-diffupdate.js
//
// 只下載，不安裝。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.CDP_PORT || 9302);
const CACHE = path.join(process.env.LOCALAPPDATA || '', 'socks5-client-updater');

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

// 所有實體網卡的累計接收位元組
const rxBytes = () => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum'],
      { encoding: 'ascii', timeout: 15000 });
    return Number(String(out).trim()) || 0;
  } catch (e) { return 0; }
};

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    return c;
  }
  send(method, params = {}, ms = 600000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
    });
  }
  async eval(e, ms) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, ms);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }
}

const lsPending = () => { try { return fs.readdirSync(path.join(CACHE, 'pending')); } catch (e) { return []; } };
const hasBlockmap = () => { try { return fs.existsSync(path.join(CACHE, 'current.blockmap')); } catch (e) { return false; } };

(async () => {
  const t = (await getJSON('/json/list')).find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!t) throw new Error('找不到 CDP target');
  const c = await CDP.connect(t.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 1200));

  const cur = await c.eval(`window.api.getAppInfo().then(i => i && i.version)`).catch(() => '?');
  console.log('目前版本            :', cur);
  console.log('current.blockmap 在嗎:', hasBlockmap() ? '在（應該走差分）' : '不在（會整包下載）');
  console.log('pending 目前內容     :', JSON.stringify(lsPending()));

  const chk = JSON.parse(await c.eval(`window.api.checkForUpdates().then(x => JSON.stringify(x))`, 120000));
  if (!chk.ok) throw new Error('檢查更新失敗：' + JSON.stringify(chk));
  console.log('線上最新版          :', chk.version);

  await c.eval(`window.__p = []; window.__off && window.__off();
    window.__off = window.api.onUpdateStatus(s => { if (s && s.status === 'downloading') window.__p.push(s.percent); }); 1`);

  const rx0 = rxBytes();
  const t0 = Date.now();
  const r = JSON.parse(await c.eval(`window.api.downloadUpdate().then(x => JSON.stringify(x))`, 900000));
  const secs = (Date.now() - t0) / 1000;
  const rx1 = rxBytes();
  if (!r.ok) throw new Error('下載失敗：' + JSON.stringify(r).slice(0, 200));

  const mb = (rx1 - rx0) / 1048576;
  const progress = await c.eval(`window.__p.length`);
  const file = lsPending().find(f => /\.exe$/i.test(f));
  const fileMb = file ? fs.statSync(path.join(CACHE, 'pending', file)).size / 1048576 : 0;

  console.log('');
  console.log('  下載耗時          : ' + secs.toFixed(1) + ' s');
  console.log('  網卡實際收到      : ' + mb.toFixed(1) + ' MB   ← 這是重點');
  console.log('  產出的安裝檔      : ' + fileMb.toFixed(1) + ' MB（' + (file || '無') + '）');
  console.log('  進度事件          : ' + progress + ' 次');
  console.log('');
  if (fileMb > 1 && mb < fileMb * 0.6) {
    console.log('  → 收到的位元組遠少於檔案大小：差分更新有生效');
  } else {
    console.log('  → 收到的量跟整個檔案差不多：這次是整包下載');
  }
  process.exit(0);
})().catch(e => { console.error('BENCH ERROR: ' + e.message); process.exit(1); });
