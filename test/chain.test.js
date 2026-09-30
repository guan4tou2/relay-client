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

// 上游把 SOCKS 回覆跟伺服器的第一段資料黏在同一個封包送來（SSH banner、SMTP 問候這類伺服器先開口的協定）。
// socks 套件會把那段多餘位元組留到 setImmediate 才補發；以前呼叫端一 pipe() 就先流出後到的資料，
// 補發的反而排到後面 —— Windows CI 上實際發生過（收到 "DEST" 而不是 "UP1-DEST"）。
// Linux 的 loopback 不容易讓「後到的資料」先進可讀緩衝區，所以這裡用 push() 模擬 Windows 的情況。
describe('握手時黏在回覆後面的資料，順序不能亂', () => {
  const { connectViaProxy } = require('../src/proxy/connect');
  function socks5WithBanner(banner) {
    return net.createServer((sock) => {
      sock.once('data', () => {
        sock.write(Buffer.from([0x05, 0x00]));
        sock.once('data', () => {
          // 回覆 + banner 一次寫出 → 必定同一個封包
          sock.write(Buffer.concat([Buffer.from([0x05, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from(banner)]));
        });
      });
    });
  }
  const collect = (sock, want) => new Promise((res, rej) => {
    let buf = '';
    const out = new (require('stream').Writable)({ write(c, _e, cb) { buf += c; if (buf.length >= want) res(buf); cb(); } });
    sock.pipe(out);
    sock.setTimeout(4000, () => rej(new Error('read timeout: ' + JSON.stringify(buf))));
  });

  for (const [name, connect] of [
    ['單跳', (p) => connectViaProxy(hop(p), { host: 'x.test', port: 22 })],
    ['串鏈的最後一跳', async (p) => {
      const a = makeSocks5(); const ap = await listen(a);
      const s = await connectViaChain([hop(ap), hop(p)], { host: 'x.test', port: 22 });
      s.once('close', () => a.close());
      return s;
    }],
  ]) {
    test(`${name}：banner 在後到的資料前面`, async () => {
      const up = socks5WithBanner('SSH-2.0-banner\r\n');
      const port = await listen(up);
      let sock;
      try {
        sock = await connect(port);
        sock.push(Buffer.from('LATER'));   // 作業系統已經讀進來、排在 banner 之後的資料
        expect(await collect(sock, 'SSH-2.0-banner\r\nLATER'.length)).toBe('SSH-2.0-banner\r\nLATER');
      } finally {
        if (sock) sock.destroy();          // 失敗時也要收乾淨，不然 jest 會等不到結束
        await close(up);
      }
    });
  }
});
