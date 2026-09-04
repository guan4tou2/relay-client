const net = require('net');
const { connectViaChain } = require('../src/proxy/connect');

// 極簡 SOCKS5 轉發 server（no-auth, CONNECT）：收到 CONNECT (host,port) 就開真 TCP 並雙向 pipe。
// 用來當作鏈中的一跳，驗證 connectViaChain 會在既有通道上正確做下一跳的 handshake。
function makeSocks5() {
  return net.createServer((sock) => {
    sock.once('data', () => {                 // greeting
      sock.write(Buffer.from([0x05, 0x00]));  // 選 no-auth
      sock.once('data', (req) => {            // CONNECT request
        const atyp = req[3];
        let host, off;
        if (atyp === 1) { host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`; off = 8; }
        else if (atyp === 3) { const len = req[4]; host = req.slice(5, 5 + len).toString(); off = 5 + len; }
        else { sock.destroy(); return; }
        const port = req.readUInt16BE(off);
        const upstream = net.connect(port, host, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // success
          sock.pipe(upstream); upstream.pipe(sock);
        });
        upstream.once('error', () => { try { sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (e) {} sock.destroy(); });
      });
    });
  });
}

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const close = (server) => new Promise((res) => server.close(res));
const hop = (port) => ({ type: 'socks5', host: '127.0.0.1', port });

function readFirst(socket) {
  return new Promise((res, rej) => {
    socket.once('data', (d) => res(d.toString()));
    socket.once('error', rej);
    socket.setTimeout(4000, () => rej(new Error('read timeout')));
  });
}

describe('connectViaChain — 多跳代理串鏈', () => {
  const BANNER = 'HELLO-VIA-CHAIN';
  let dest, destPort;

  beforeAll(async () => {
    dest = net.createServer((s) => { s.write(BANNER); s.on('data', (d) => s.write(d)); }); // 送 banner + echo
    destPort = await listen(dest);
  });
  afterAll(async () => { await close(dest); });

  test('1 跳鏈可送達資料', async () => {
    const a = makeSocks5(); const ap = await listen(a);
    const sock = await connectViaChain([hop(ap)], { host: '127.0.0.1', port: destPort });
    expect(await readFirst(sock)).toBe(BANNER);
    sock.destroy(); await close(a);
  });

  test('2 跳鏈穿過兩個 proxy 送達資料', async () => {
    const a = makeSocks5(); const ap = await listen(a);
    const b = makeSocks5(); const bp = await listen(b);
    const sock = await connectViaChain([hop(ap), hop(bp)], { host: '127.0.0.1', port: destPort });
    expect(await readFirst(sock)).toBe(BANNER);
    sock.destroy(); await close(a); await close(b);
  });

  test('3 跳鏈可送達資料', async () => {
    const servers = []; const ports = [];
    for (let i = 0; i < 3; i++) { const s = makeSocks5(); servers.push(s); ports.push(await listen(s)); }
    const sock = await connectViaChain(ports.map(hop), { host: '127.0.0.1', port: destPort });
    expect(await readFirst(sock)).toBe(BANNER);
    sock.destroy(); for (const s of servers) await close(s);
  });

  test('2 跳鏈可雙向往返 payload（echo）', async () => {
    const a = makeSocks5(); const ap = await listen(a);
    const b = makeSocks5(); const bp = await listen(b);
    const sock = await connectViaChain([hop(ap), hop(bp)], { host: '127.0.0.1', port: destPort });
    await readFirst(sock); // 先吃掉 banner
    const got = await new Promise((res, rej) => {
      sock.once('data', (d) => res(d.toString()));
      sock.setTimeout(4000, () => rej(new Error('echo timeout')));
      sock.write('ping-42');
    });
    expect(got).toBe('ping-42');
    sock.destroy(); await close(a); await close(b);
  });

  test('空鏈被拒絕', async () => {
    await expect(connectViaChain([], { host: '127.0.0.1', port: destPort })).rejects.toThrow('empty proxy chain');
  });

  test('失敗時錯誤訊息標明是第幾跳', async () => {
    const a = makeSocks5(); const ap = await listen(a);
    // 第 2 跳指向沒人聽的 port → 第 1 跳無法連過去 → 錯誤應標明 hop 1/2
    const chain = [hop(ap), hop(1)];
    await expect(connectViaChain(chain, { host: '127.0.0.1', port: destPort })).rejects.toThrow(/chain hop 1\/2/);
    await close(a);
  });
});
