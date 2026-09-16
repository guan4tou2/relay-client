// 量「每個資料 chunk 一次 IPC」在真 app 裡的代價。
//
// bench-relay.js 量的是行程內 emit 的成本；真正貴的是它後面那一段：
// RouteManager 把每次 stats 轉成 webContents.send('route-stats')，
// 每一則都要結構化複製、跨行程、在 renderer 端喚醒一次 JS。
//
// 做法：自己起一個假的上游 SOCKS5 + 接收端，叫 app 建一條指過去的路由，
// 從外面全速灌資料，同時在 renderer 數收到幾則 route-stats。
//
//   dist\win-unpacked\RelayClient.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\bench
//   CDP_PORT=9222 node scripts/bench-ipc.js [MB]

const http = require('http');
const net = require('net');

const PORT = Number(process.env.CDP_PORT || 9222);
const MB = Number(process.argv[2] || 128);
const CHUNK = 64 * 1024;
const PAYLOAD = Buffer.alloc(CHUNK, 0x61);

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const listen = (s, p) => new Promise(r => s.listen(p, '127.0.0.1', () => r(s.address().port)));

function makeSink() {
  let got = 0;
  const srv = net.createServer(s => { s.on('data', c => { got += c.length; }); s.on('error', () => {}); });
  return { srv, bytes: () => got };
}
function makeUpstream(sinkPort) {
  return net.createServer(s => {
    let stage = 0;
    s.on('error', () => {});
    const onData = () => {
      if (stage === 0) { s.write(Buffer.from([0x05, 0x00])); stage = 1; return; }
      const reply = Buffer.alloc(10); reply[0] = 0x05; reply[1] = 0x00; reply[3] = 0x01;
      s.write(reply); stage = 2;
      const out = net.connect(sinkPort, '127.0.0.1', () => s.pipe(out));
      out.on('error', () => {});
      s.removeListener('data', onData);
    };
    s.on('data', onData);
  });
}
function pushThrough(relayPort, totalBytes) {
  return new Promise((resolve, reject) => {
    const c = net.connect(relayPort, '127.0.0.1');
    let stage = 0, sent = 0, t0 = 0;
    c.on('error', reject);
    c.on('connect', () => c.write(Buffer.from([0x05, 0x01, 0x00])));
    c.on('data', () => {
      if (stage === 0) {
        stage = 1;
        const p = Buffer.alloc(2); p.writeUInt16BE(9);
        c.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1]), p]));
        return;
      }
      if (stage === 1) {
        stage = 2; t0 = process.hrtime.bigint();
        const pump = () => {
          while (sent < totalBytes) {
            const ok = c.write(PAYLOAD); sent += PAYLOAD.length;
            if (!ok) { c.once('drain', pump); return; }
          }
          c.end();
          resolve(Number(process.hrtime.bigint() - t0) / 1e9);
        };
        pump();
      }
    });
  });
}

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
  send(method, params = {}, ms = 60000) {
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

(async () => {
  const sink = makeSink();
  const sinkPort = await listen(sink.srv, 0);
  const upPort = await listen(makeUpstream(sinkPort), 0);

  const t = (await getJSON('/json/list')).find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!t) throw new Error('找不到 CDP target');
  const c = await CDP.connect(t.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 1200));

  // 建一台指向假上游的伺服器 + 一條路由
  const srvId = await c.eval(`window.api.addServer({ label: 'bench', host: '127.0.0.1', port: ${upPort}, type: 'socks5' }).then(s => (s && (s.id || (s[s.length-1] && s[s.length-1].id))) || null)`);
  const servers = JSON.parse(await c.eval(`window.api.getServers().then(s => JSON.stringify(s))`));
  const sid = srvId || (servers.find(s => s.label === 'bench') || {}).id;
  if (!sid) throw new Error('建不出伺服器');
  const routePort = 13579;
  await c.eval(`window.api.saveRoute({ id: 'bench-route', label: 'bench', kind: 'socks5', localPort: ${routePort}, hops: ['${sid}'], enabled: true }).then(()=>1)`);
  const started = JSON.parse(await c.eval(`window.api.routeStart('bench-route').then(r => JSON.stringify(r))`));
  if (!started.ok) throw new Error('路由起不來：' + JSON.stringify(started));
  await new Promise(r => setTimeout(r, 800));

  // 在 renderer 端數 route-stats
  await c.eval(`window.__rs = 0; window.__off && window.__off();
    window.__off = window.api.onRouteStats(() => { window.__rs++; }); 1`);

  console.log(`灌 ${MB} MB 通過 app 的路由（127.0.0.1:${routePort}）…`);
  const secs = await pushThrough(routePort, MB * 1024 * 1024);
  await new Promise(r => setTimeout(r, 1500));
  const msgs = await c.eval(`window.__rs`);

  console.log('');
  console.log(`  吞吐量          : ${(MB / secs).toFixed(0)} MB/s（${secs.toFixed(2)}s）`);
  console.log(`  renderer 收到   : ${msgs} 則 route-stats`);
  console.log(`  平均            : 每秒 ${(msgs / secs).toFixed(0)} 則、每 ${(MB * 1024 / Math.max(1, msgs)).toFixed(0)} KB 一則`);
  console.log(`  接收端收到      : ${(sink.bytes() / 1048576).toFixed(0)} MB`);

  await c.eval(`window.api.routeStop('bench-route')`).catch(() => {});
  await c.eval(`window.api.deleteRoute('bench-route', { keepProfile: false })`).catch(() => {});
  await c.eval(`window.api.deleteServer('${sid}')`).catch(() => {});
  process.exit(0);
})().catch(e => { console.error('BENCH ERROR', e.message); process.exit(1); });
