const net = require('net');
const { SocksClient } = require('socks');
const RouteManager = require('../src/proxy/route-manager');

// 帶標記的 SOCKS5 轉發 server：CONNECT 後先寫入 tag 再 pipe，用來證明流量確實走了這一台上游。
function makeTaggedSocks5(tag) {
  return net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(Buffer.from([0x05, 0x00]));
      sock.once('data', (req) => {
        const atyp = req[3]; let host, off;
        if (atyp === 1) { host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`; off = 8; }
        else if (atyp === 3) { const len = req[4]; host = req.slice(5, 5 + len).toString(); off = 5 + len; }
        else { sock.destroy(); return; }
        const port = req.readUInt16BE(off);
        const up = net.connect(port, host, () => {
          sock.write(Buffer.from([0x05, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (tag) sock.write(tag);
          sock.pipe(up); up.pipe(sock);
        });
        up.once('error', () => { try { sock.write(Buffer.from([0x05, 1, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (e) {} sock.destroy(); });
      });
    });
  });
}

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => s.close(r));
const getFreePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const hop = (port) => ({ type: 'socks5', host: '127.0.0.1', port });

function viaPort(port, dest) {
  return SocksClient.createConnection({ proxy: { host: '127.0.0.1', port, type: 5 }, command: 'connect', destination: dest, timeout: 8000 }).then((i) => i.socket);
}
function readUntil(sock, min) {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= min) { sock.removeListener('data', onData); res(buf.toString()); } };
    sock.on('data', onData);
    sock.once('error', rej);
    sock.setTimeout(4000, () => rej(new Error('read timeout')));
  });
}

describe('RouteManager — 多端口、各自綁不同上游', () => {
  const BANNER = 'DEST-OK';
  let dest, destPort, mgr;

  beforeAll(async () => { dest = net.createServer((s) => { s.write(BANNER); s.on('data', (d) => s.write(d)); }); destPort = await listen(dest); });
  afterAll(async () => { await close(dest); });
  beforeEach(() => { mgr = new RouteManager(); mgr.on('error', () => {}); });
  afterEach(async () => { await mgr.stopAll(); });

  test('兩個 port 同時各自路由到不同上游', async () => {
    const A = makeTaggedSocks5('AAA'); const aport = await listen(A);
    const B = makeTaggedSocks5('BBB'); const bport = await listen(B);
    const pA = await getFreePort(); const pB = await getFreePort();
    await mgr.start({ id: 'a', localPort: pA, kind: 'socks5', hops: [hop(aport)] });
    await mgr.start({ id: 'b', localPort: pB, kind: 'socks5', hops: [hop(bport)] });

    const sA = await viaPort(pA, { host: '127.0.0.1', port: destPort });
    expect(await readUntil(sA, 3 + BANNER.length)).toBe('AAA' + BANNER); // 走了上游 A

    const sB = await viaPort(pB, { host: '127.0.0.1', port: destPort });
    expect(await readUntil(sB, 3 + BANNER.length)).toBe('BBB' + BANNER); // 走了上游 B

    sA.destroy(); sB.destroy(); await close(A); await close(B);
  });

  test('單一 port 可綁定多跳串鏈', async () => {
    const A = makeTaggedSocks5(''); const aport = await listen(A);
    const B = makeTaggedSocks5(''); const bport = await listen(B);
    const p = await getFreePort();
    await mgr.start({ id: 'chain', localPort: p, kind: 'socks5', hops: [hop(aport), hop(bport)] });
    const s = await viaPort(p, { host: '127.0.0.1', port: destPort });
    expect(await readUntil(s, BANNER.length)).toContain(BANNER);
    s.destroy(); await close(A); await close(B);
  });

  test('apply() 依清單起停 routes（enabled 切換）', async () => {
    const A = makeTaggedSocks5(''); const aport = await listen(A);
    const p1 = await getFreePort(); const p2 = await getFreePort();
    const routes = [
      { id: 'r1', localPort: p1, kind: 'socks5', hops: [hop(aport)], enabled: true },
      { id: 'r2', localPort: p2, kind: 'socks5', hops: [hop(aport)], enabled: false },
    ];
    await mgr.apply(routes);
    expect(mgr.isRunning('r1')).toBe(true);
    expect(mgr.isRunning('r2')).toBe(false);

    routes[0].enabled = false; routes[1].enabled = true;
    await mgr.apply(routes);
    expect(mgr.isRunning('r1')).toBe(false);
    expect(mgr.isRunning('r2')).toBe(true);
    await close(A);
  });

  test('status() 回報執行中的 routes', async () => {
    const A = makeTaggedSocks5(''); const aport = await listen(A);
    const p = await getFreePort();
    await mgr.start({ id: 's1', localPort: p, kind: 'socks5', hops: [hop(aport)] });
    const st = mgr.status();
    expect(st).toEqual([{ id: 's1', localPort: p, kind: 'socks5', hops: 1, running: true }]);
    await close(A);
  });

  test('同一 port 已被占用時 start 會失敗（供上層做衝突阻擋）', async () => {
    const A = makeTaggedSocks5(''); const aport = await listen(A);
    const p = await getFreePort();
    await mgr.start({ id: 'first', localPort: p, kind: 'socks5', hops: [hop(aport)] });
    await expect(mgr.start({ id: 'second', localPort: p, kind: 'socks5', hops: [hop(aport)] }))
      .rejects.toThrow(/EADDRINUSE|address already in use/i);
    expect(mgr.isRunning('second')).toBe(false);
    await close(A);
  });

  test('拒絕不合法 route', async () => {
    await expect(mgr.start({ id: 'x', localPort: 0, kind: 'socks5', hops: [hop(1)] })).rejects.toThrow('invalid localPort');
    await expect(mgr.start({ id: 'x', localPort: 1080, kind: 'bogus', hops: [hop(1)] })).rejects.toThrow('invalid kind');
    await expect(mgr.start({ id: 'x', localPort: 1080, kind: 'socks5', hops: [] })).rejects.toThrow('non-empty');
  });
});
