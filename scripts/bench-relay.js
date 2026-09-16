// 中繼資料路徑的吞吐量基準。
//
// 量的是「每個資料 chunk 都 emit 一次 stats」這件事的代價：
// SocksRelay / HttpBridge 在 clientSocket.on('data') 與 remoteSocket.on('data')
// 裡各 emit 一次，那個事件會一路轉成 webContents.send('route-stats')，
// 也就是「每一個網路封包一次 IPC」。
//
// 這支不進 Electron，只量 relay 自己：假的上游 SOCKS5 + 假的接收端，
// 中間夾真的 SocksRelay，把 N MB 推過去。
//
//   node scripts/bench-relay.js [MB]

const net = require('net');
const SocksRelay = require('../src/proxy/socks-relay');

const MB = Number(process.argv[2] || 256);
const CHUNK = 64 * 1024;
const PAYLOAD = Buffer.alloc(CHUNK, 0x61);

const listen = (server, port) => new Promise(r => server.listen(port, '127.0.0.1', () => r(server.address().port)));

// 接收端：收下就丟掉，只數 bytes
function makeSink() {
  let got = 0;
  const srv = net.createServer(s => { s.on('data', c => { got += c.length; }); s.on('error', () => {}); });
  return { srv, bytes: () => got };
}

// 最小可用的上游 SOCKS5：握手 → CONNECT → 接到 sink
function makeUpstream(sinkPort) {
  return net.createServer(s => {
    let stage = 0;
    s.on('error', () => {});
    const onData = (buf) => {
      if (stage === 0) { s.write(Buffer.from([0x05, 0x00])); stage = 1; return; }
      if (stage === 1) {
        const reply = Buffer.alloc(10);
        reply[0] = 0x05; reply[1] = 0x00; reply[3] = 0x01;
        s.write(reply);
        stage = 2;
        const out = net.connect(sinkPort, '127.0.0.1', () => { s.pipe(out); });
        out.on('error', () => {});
        s.removeListener('data', onData);
        return;
      }
    };
    s.on('data', onData);
  });
}

// 透過 relay 的 SOCKS5 介面連出去，然後全速灌資料
function pushThrough(relayPort, totalBytes) {
  return new Promise((resolve, reject) => {
    const c = net.connect(relayPort, '127.0.0.1');
    let stage = 0, sent = 0, t0 = 0;
    c.on('error', reject);
    c.on('connect', () => c.write(Buffer.from([0x05, 0x01, 0x00])));
    c.on('data', () => {
      if (stage === 0) {
        stage = 1;
        const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(9); return b; })()]);
        c.write(req);
        return;
      }
      if (stage === 1) {
        stage = 2; t0 = process.hrtime.bigint();
        const pump = () => {
          while (sent < totalBytes) {
            const ok = c.write(PAYLOAD);
            sent += PAYLOAD.length;
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

(async () => {
  const sink = makeSink();
  const sinkPort = await listen(sink.srv, 0);
  const upstream = makeUpstream(sinkPort);
  const upPort = await listen(upstream, 0);

  const results = [];
  for (const withListener of [false, true]) {
    const relay = new SocksRelay();
    let statsEvents = 0;
    if (withListener) relay.on('stats', () => { statsEvents++; });
    relay.on('log', () => {});
    relay.on('error', () => {});
    await relay.start(0, { host: '127.0.0.1', port: upPort, type: 'socks5' });
    const relayPort = relay.server.address().port;

    const cpu0 = process.cpuUsage();
    const secs = await pushThrough(relayPort, MB * 1024 * 1024);
    const cpu = process.cpuUsage(cpu0);
    await new Promise(r => setTimeout(r, 300));
    relay.stop();

    const mbps = MB / secs;
    results.push({ withListener, secs, mbps, statsEvents, cpuMs: Math.round((cpu.user + cpu.system) / 1000) });
    console.log(
      (withListener ? '有 stats 監聽（＝ app 實際情況）' : '沒有 stats 監聽（對照組）   ').padEnd(34) +
      ` ${secs.toFixed(2)}s  ${mbps.toFixed(0)} MB/s  CPU ${Math.round((cpu.user + cpu.system) / 1000)}ms  stats 事件 ${statsEvents}`);
  }

  const [off, on] = results;
  const slow = ((off.mbps - on.mbps) / off.mbps * 100);
  console.log('');
  console.log(`每 ${MB} MB 送出 ${on.statsEvents} 次 stats 事件` +
    `（平均每 ${(MB * 1024 / Math.max(1, on.statsEvents)).toFixed(0)} KB 一次）`);
  console.log(`吞吐量差異：${slow >= 0 ? '慢了' : '快了'} ${Math.abs(slow).toFixed(1)}%，CPU ${off.cpuMs}ms → ${on.cpuMs}ms`);
  process.exit(0);
})().catch(e => { console.error('BENCH ERROR', e); process.exit(1); });
