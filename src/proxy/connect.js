const net = require('net');
const tls = require('tls');
const { SocksClient } = require('socks');

// 憑證驗證預設開啟；只有使用者對那台伺服器明確勾了「略過憑證驗證」（proxy.tlsInsecure）才關。
// 關掉驗證的話，路上任何人都能冒充代理，收走 Proxy-Authorization 裡的帳密。
const CERT_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
/** @param {any} err */
function explainTlsError(err) {
  if (!err || !CERT_ERRORS.has(err.code)) return err;
  const e = /** @type {NodeJS.ErrnoException} */ (new Error(`${err.message}（代理伺服器的憑證無法驗證；如果它使用自簽憑證，可在伺服器設定開啟「略過憑證驗證」）`));
  e.code = err.code;
  return e;
}

// TLS 選項：IP 不能當 SNI（Node 會警告），但驗證時仍要比對 IP，所以 IP 放 host、網域放 servername
function tlsOptions(proxy) {
  const opts = { rejectUnauthorized: !proxy.tlsInsecure };
  if (net.isIP(proxy.host)) opts.host = proxy.host; else opts.servername = proxy.host;
  return opts;
}

// 單跳：等同 connectViaChain([proxy], destination)，行為與舊版一致。
async function connectViaProxy(proxy, destination) {
  const socket = await chainHop(proxy, destination, null);
  return isSocks(proxy) ? settleSocksSocket(socket) : socket;
}

const isSocks = (proxy) => { const t = proxy.type || 'socks5'; return t === 'socks5' || t === 'socks4'; };

// socks 套件握手完成時，跟回覆黏在同一個封包裡的多餘位元組（伺服器先開口的協定：SSH banner、
// SMTP 問候…）不會馬上交出來，而是等下一輪事件迴圈（setImmediate）才 emit('data') 補發並 resume()。
// 呼叫端一拿到 socket 就 pipe() 的話，pipe 會先把 socket 恢復流動，後到的資料先流出去，
// 補發的那段反而排到後面 —— 位元組順序就亂了（Windows 上兩次 write 常被合成一個封包，實際發生過）。
// 這裡先接住補發的資料；真的有的話，暫停 socket、照原順序放回可讀緩衝區，之後從頭依序送出。
// 沒有多餘位元組（大多數情況）就原封不動交出去。
// 只用在交給呼叫端的最後一個 socket：串鏈中間那幾跳還要被下一跳的 socks 套件接著讀。
function settleSocksSocket(socket) {
  return new Promise((resolve) => {
    const early = [];
    const onData = (chunk) => early.push(chunk);
    socket.on('data', onData);
    setImmediate(() => {   // 排在 socks 套件自己的 setImmediate 之後（那個在握手完成、我們拿到 socket 之前就排好了）
      socket.removeListener('data', onData);
      if (early.length) {
        socket.pause();
        socket.unshift(Buffer.concat(early));
        // pause() 之後再加 'data' listener 不會自動恢復流動（pipe 會）。把「加了 listener 就開始流」的
        // 預設行為接回來，只用 on('data') 讀的呼叫端才不會卡住。
        const onListener = (ev) => {
          if (ev !== 'data') return;
          socket.removeListener('newListener', onListener);
          process.nextTick(() => socket.resume());
        };
        socket.on('newListener', onListener);
      }
      resolve(socket);
    });
  });
}

// 多跳串鏈（proxychains 型）：client → chain[0] → chain[1] → … → destination。
// 每一跳都在「已穿過前面所有跳的 socket」上做該 proxy 的 handshake，要求它連到下一個目標
// （下一個 proxy 的位址，或最後一跳的真正 destination）。
async function connectViaChain(chain, destination) {
  if (!Array.isArray(chain) || chain.length === 0) throw new Error('empty proxy chain');
  let socket = null;
  for (let i = 0; i < chain.length; i++) {
    const last = i === chain.length - 1;
    const target = last
      ? { host: destination.host, port: destination.port }
      : { host: chain[i + 1].host, port: chain[i + 1].port };
    try {
      socket = await chainHop(chain[i], target, socket);
    } catch (err) {
      if (socket) socket.destroy();
      const p = chain[i];
      throw new Error(`chain hop ${i + 1}/${chain.length} (${p.type || 'socks5'} ${p.host}:${p.port}) failed: ${err.message}`, { cause: err });
    }
  }
  return isSocks(chain[chain.length - 1]) ? settleSocksSocket(socket) : socket;
}

// 對 proxy 執行一次 handshake，要它 CONNECT 到 target。
// upstream 為 null → 這是第一跳，直接連到該 proxy；否則沿用既有通道 socket。
async function chainHop(proxy, target, upstream) {
  const type = proxy.type || 'socks5';

  if (type === 'socks5' || type === 'socks4') {
    /** @type {import('socks').SocksClientOptions} */
    const opts = {
      proxy: { host: proxy.host, port: proxy.port, type: type === 'socks5' ? 5 : 4 },
      command: 'connect',
      destination: { host: target.host, port: target.port },
      timeout: 15000,
    };
    if (proxy.username) { opts.proxy.userId = proxy.username; opts.proxy.password = proxy.password || ''; }
    if (upstream) opts.existing_socket = upstream; // 在既有通道上做 SOCKS handshake
    const info = await SocksClient.createConnection(opts);
    return info.socket;
  }

  if (type === 'http' || type === 'https') {
    let sock = upstream || await openSocketToProxy(proxy, false);
    try {
      if (type === 'https') sock = await tlsHandshake(sock, proxy); // 與 proxy 先建 TLS（可跑在通道上）
      await httpConnectOverSocket(sock, target, proxy);
      return sock;
    } catch (err) {
      if (!upstream) { try { sock.destroy(); } catch (e) {} } // 首跳自己建的 socket 要收掉，避免洩漏
      throw err;
    }
  }

  throw new Error(`Unsupported proxy type: ${type}`);
}

function openSocketToProxy(proxy, useTls) {
  return new Promise((resolve, reject) => {
    let socket;
    const onError = (err) => { socket.destroy(); reject(explainTlsError(err)); };
    const onTimeout = () => { socket.destroy(); reject(new Error('Proxy connection timeout')); };

    const onConnect = () => {
      socket.setTimeout(0);                     // 連上後清掉逾時，否則它會變成「閒置 15s 就砍活連線」
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      resolve(socket);
    };
    if (useTls) {
      socket = tls.connect({ ...tlsOptions(proxy), port: proxy.port, host: proxy.host }, onConnect);
    } else {
      socket = net.connect(proxy.port, proxy.host, onConnect);
    }
    socket.setTimeout(15000);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

// 在既有 socket 上跟對端做 TLS（用於 https proxy，含通道上的 TLS-in-tunnel）。
function tlsHandshake(socket, proxy) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => reject(explainTlsError(err));
    const t = tls.connect({ ...tlsOptions(proxy), socket }, () => {
      t.setTimeout(0);                          // 握手完成 → 清掉逾時，避免砍掉活的 TLS 通道
      t.removeListener('error', onErr);
      resolve(t);
    });
    t.setTimeout(15000, () => { t.destroy(); reject(new Error('TLS handshake timeout')); });
    t.once('error', onErr);
  });
}

// 在既有 socket 上送 HTTP CONNECT 到 destination（socket 已連到某 http/https proxy）。
async function httpConnectOverSocket(socket, destination, proxy) {
  let header = `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\n`;
  header += `Host: ${destination.host}:${destination.port}\r\n`;
  if (proxy.username) {
    const cred = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    header += `Proxy-Authorization: Basic ${cred}\r\n`;
  }
  header += '\r\n';
  socket.write(header);

  const { statusCode, remaining } = await readHttpStatus(socket);
  if (statusCode !== 200) {
    socket.destroy();
    throw new Error(`HTTP proxy CONNECT returned ${statusCode}`);
  }
  if (remaining.length > 0) socket.unshift(remaining);
}

function readHttpStatus(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onErr); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('HTTP proxy CONNECT timeout')); }, 15000); // proxy 收了連線卻不回 CONNECT → 不要無限等
    if (timer.unref) timer.unref();
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const str = buf.toString();
      const end = str.indexOf('\r\n\r\n');
      if (end === -1) return;
      cleanup();
      const line = str.substring(0, str.indexOf('\r\n'));
      const m = line.match(/^HTTP\/\d\.\d (\d{3})/);
      if (!m) return reject(new Error('Invalid HTTP response from proxy'));
      resolve({ statusCode: parseInt(m[1], 10), remaining: buf.slice(end + 4) });
    };
    const onErr = (err) => { cleanup(); reject(err); };
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}

// 逐一掛在 module.exports 上：.js 裡的 object literal 型別是「可擴充的」，
// 寫成 module.exports = { ... } 的話 npm run typecheck 抓不到呼叫端拼錯的名字。
module.exports.connectViaProxy = connectViaProxy;
module.exports.connectViaChain = connectViaChain;
module.exports.chainHop = chainHop;
module.exports.openSocketToProxy = openSocketToProxy;
module.exports.tlsOptions = tlsOptions;
module.exports.explainTlsError = explainTlsError;
