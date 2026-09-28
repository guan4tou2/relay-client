const net = require('net');
const path = require('path');
const { fork } = require('child_process');
const { SocksClient } = require('socks');
const RemoteRouteManager = require('../src/proxy/remote-route-manager');

// 中繼搬到獨立行程之後，主行程只剩 RemoteRouteManager 這個替身。
// 這裡用 Node 的 child_process.fork 跑真的 relay-host.js（協定跟 Electron utilityProcess 一樣），
// 真的起中繼、真的轉送流量，驗證跨行程的指令、狀態快照、事件與「當掉後自動恢復」。

const HOST = path.join(__dirname, '..', 'src', 'proxy', 'relay-host.js');
const children = [];
function spawnNode() {
  const cp = fork(HOST, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(cp);
  return { postMessage: (m) => cp.send(m), on: (ev, fn) => cp.on(ev, fn), kill: () => cp.kill(), _cp: cp };
}
afterAll(() => { for (const cp of children) { try { cp.kill(); } catch (e) {} } });

// 會在回應前先寫一段 tag 的 SOCKS5 上游：證明流量真的經過它
function taggedSocks5(tag) {
  return net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(Buffer.from([0x05, 0x00]));
      sock.once('data', (req) => {
        const len = req[4]; const host = req.slice(5, 5 + len).toString(); const port = req.readUInt16BE(5 + len);
        const up = net.connect(port, host, () => {
          sock.write(Buffer.from([0x05, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.write(tag);
          sock.pipe(up); up.pipe(sock);
        });
        up.once('error', () => sock.destroy());
      });
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => s.close(r));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const once = (em, ev) => new Promise((r) => em.once(ev, (...a) => r(a)));

async function fetchVia(port, destPort) {
  const { socket } = await SocksClient.createConnection({
    proxy: { host: '127.0.0.1', port, type: 5 }, command: 'connect',
    destination: { host: 'localhost', port: destPort }, timeout: 8000,
  });
  return new Promise((res, rej) => {
    let buf = '';
    socket.on('data', (d) => { buf += d; if (buf.includes('DEST')) { socket.destroy(); res(buf); } });
    socket.once('error', rej);
    socket.setTimeout(5000, () => rej(new Error('read timeout')));
  });
}

describe('RemoteRouteManager — 中繼跑在獨立行程', () => {
  let dest, destPort, up, upPort;
  beforeAll(async () => {
    dest = net.createServer((s) => s.write('DEST'));
    destPort = await listen(dest);
    up = taggedSocks5('UP1-');
    upPort = await listen(up);
  });
  afterAll(async () => { await close(dest); await close(up); });

  test('啟動路由：流量經過指定上游，狀態快照同步回來', async () => {
    const rm = new RemoteRouteManager({ spawn: spawnNode });
    const port = await freePort();
    const started = once(rm, 'started');
    await rm.start({ id: 'a', localPort: port, kind: 'socks5', hops: [{ type: 'socks5', host: '127.0.0.1', port: upPort }] });
    expect(await started).toEqual(['a']);
    // start() 回來的當下，同步的 status()/isRunning() 就已經是新狀態（快照比回覆先到）
    expect(rm.isRunning('a')).toBe(true);
    expect(rm.status()).toEqual([expect.objectContaining({ id: 'a', localPort: port, kind: 'socks5', hops: 1, running: true })]);
    expect(await fetchVia(port, destPort)).toBe('UP1-DEST');
    await rm.stopAll();
    expect(rm.status()).toEqual([]);
    rm.dispose();
  });

  test('中繼的紀錄與統計會轉送回主行程', async () => {
    const rm = new RemoteRouteManager({ spawn: spawnNode });
    const logs = []; const stats = [];
    rm.on('log', (...a) => logs.push(a));
    rm.on('stats', (...a) => stats.push(a));
    const port = await freePort();
    await rm.start({ id: 'b', localPort: port, kind: 'socks5', hops: [{ type: 'socks5', host: '127.0.0.1', port: upPort }] });
    await fetchVia(port, destPort);
    await new Promise((r) => setTimeout(r, 300));
    expect(logs.some(([id, , msg]) => id === 'b' && /CONNECT/.test(msg))).toBe(true);
    expect(stats.some(([id]) => id === 'b')).toBe(true);
    await rm.stopAll();
    rm.dispose();
  });

  test('啟動失敗（埠被占用）會把錯誤原因帶回來，狀態不留殘影', async () => {
    const blocker = net.createServer();
    const port = await listen(blocker);
    const rm = new RemoteRouteManager({ spawn: spawnNode });
    rm.on('error', () => {});
    await expect(rm.start({ id: 'c', localPort: port, kind: 'socks5', hops: [{ type: 'socks5', host: '127.0.0.1', port: upPort }] }))
      .rejects.toThrow(/EADDRINUSE|in use/i);
    expect(rm.isRunning('c')).toBe(false);
    await close(blocker);
    rm.dispose();
  });

  test('中繼行程當掉：先回報路由停了，再自動重開並把路由拉回來', async () => {
    let spawned = 0;
    const rm = new RemoteRouteManager({ spawn: () => { spawned++; return spawnNode(); } });
    const port = await freePort();
    await rm.start({ id: 'd', localPort: port, kind: 'socks5', hops: [{ type: 'socks5', host: '127.0.0.1', port: upPort }] });
    const stopped = once(rm, 'stopped');
    const settled = once(rm, 'settled');
    children[children.length - 1].kill('SIGKILL');   // 模擬當掉
    expect(await stopped).toEqual(['d']);
    await settled;
    expect(spawned).toBe(2);
    expect(rm.isRunning('d')).toBe(true);
    expect(await fetchVia(port, destPort)).toBe('UP1-DEST');
    await rm.stopAll();
    rm.dispose();
  });

  test('使用者停掉的路由，行程重開後不會被拉回來', async () => {
    const rm = new RemoteRouteManager({ spawn: spawnNode });
    const p1 = await freePort(); const p2 = await freePort();
    const hops = [{ type: 'socks5', host: '127.0.0.1', port: upPort }];
    await rm.start({ id: 'e1', localPort: p1, kind: 'socks5', hops });
    await rm.start({ id: 'e2', localPort: p2, kind: 'socks5', hops });
    await rm.stop('e2');
    const settled = once(rm, 'settled');
    children[children.length - 1].kill('SIGKILL');
    await settled;
    expect(rm.status().map(s => s.id)).toEqual(['e1']);
    await rm.stopAll();
    rm.dispose();
  });

  test('結束 app（dispose）後行程被收掉，不會自動重開', async () => {
    let spawned = 0;
    const rm = new RemoteRouteManager({ spawn: () => { spawned++; return spawnNode(); } });
    const port = await freePort();
    await rm.start({ id: 'f', localPort: port, kind: 'socks5', hops: [{ type: 'socks5', host: '127.0.0.1', port: upPort }] });
    const cp = children[children.length - 1];
    const exited = new Promise((r) => cp.once('exit', r));
    rm.dispose();
    await exited;
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned).toBe(1);
  });
});

describe('RemoteRouteManager — 獨立行程起不來時退回主行程', () => {
  const RouteManager = require('../src/proxy/route-manager');
  const { EventEmitter } = require('events');

  test('行程還沒 ready 就結束 → 改用主行程的 RouteManager，並記一筆警告', async () => {
    const dead = () => { const c = new EventEmitter(); c.postMessage = () => {}; c.kill = () => {}; setImmediate(() => c.emit('exit', 1)); return c; };
    const rm = new RemoteRouteManager({ spawn: dead, fallback: () => new RouteManager() });
    const logs = [];
    rm.on('log', (...a) => logs.push(a));
    const port = await freePort();
    await rm.start({ id: 'g', localPort: port, kind: 'socks5', hops: [{ type: 'socks5', host: '127.0.0.1', port: 1 }] });
    expect(rm.isRunning('g')).toBe(true);
    expect(rm.status()[0]).toEqual(expect.objectContaining({ id: 'g', localPort: port }));
    expect(logs.some(([, level, msg]) => level === 'warn' && /主行程/.test(msg))).toBe(true);
    await rm.stopAll();
    expect(rm.status()).toEqual([]);
  });

  test('spawn 直接丟例外也一樣退回', async () => {
    const rm = new RemoteRouteManager({ spawn: () => { throw new Error('no utility process'); }, fallback: () => new RouteManager() });
    const port = await freePort();
    await rm.start({ id: 'h', localPort: port, kind: 'socks5', hops: [{ type: 'socks5', host: '127.0.0.1', port: 1 }] });
    expect(rm.isRunning('h')).toBe(true);
    await rm.stopAll();
  });

  test('沒給 fallback 就把錯誤丟給呼叫端', async () => {
    const rm = new RemoteRouteManager({ spawn: () => { throw new Error('no utility process'); } });
    await expect(rm.start({ id: 'i', localPort: 1, kind: 'socks5', hops: [] })).rejects.toThrow('no utility process');
  });
});
