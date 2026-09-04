const net = require('net');
const tls = require('tls');
const { SocksClient } = require('socks');

// 單跳：等同 connectViaChain([proxy], destination)，行為與舊版一致。
async function connectViaProxy(proxy, destination) {
  return chainHop(proxy, destination, null);
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
      throw new Error(`chain hop ${i + 1}/${chain.length} (${p.type || 'socks5'} ${p.host}:${p.port}) failed: ${err.message}`);
    }
  }
  return socket;
}

// 對 proxy 執行一次 handshake，要它 CONNECT 到 target。
// upstream 為 null → 這是第一跳，直接連到該 proxy；否則沿用既有通道 socket。
async function chainHop(proxy, target, upstream) {
  const type = proxy.type || 'socks5';

  if (type === 'socks5' || type === 'socks4') {
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
    if (type === 'https') sock = await tlsHandshake(sock, proxy.host); // 與 proxy 先建 TLS（可跑在通道上）
    await httpConnectOverSocket(sock, target, proxy);
    return sock;
  }

  throw new Error(`Unsupported proxy type: ${type}`);
}

function openSocketToProxy(proxy, useTls) {
  return new Promise((resolve, reject) => {
    let socket;
    const onError = (err) => { socket.destroy(); reject(err); };
    const onTimeout = () => { socket.destroy(); reject(new Error('Proxy connection timeout')); };

    if (useTls) {
      socket = tls.connect(proxy.port, proxy.host, { rejectUnauthorized: false }, () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    } else {
      socket = net.connect(proxy.port, proxy.host, () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    }
    socket.setTimeout(15000);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

// 在既有 socket 上跟對端做 TLS（用於 https proxy，含通道上的 TLS-in-tunnel）。
function tlsHandshake(socket, servername) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, rejectUnauthorized: false }, () => {
      t.removeListener('error', reject);
      resolve(t);
    });
    t.setTimeout(15000, () => { t.destroy(); reject(new Error('TLS handshake timeout')); });
    t.once('error', reject);
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
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const str = buf.toString();
      const end = str.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const line = str.substring(0, str.indexOf('\r\n'));
      const m = line.match(/^HTTP\/\d\.\d (\d{3})/);
      if (!m) return reject(new Error('Invalid HTTP response from proxy'));
      resolve({ statusCode: parseInt(m[1], 10), remaining: buf.slice(end + 4) });
    };
    socket.on('data', onData);
    socket.once('error', (err) => { socket.removeListener('data', onData); reject(err); });
  });
}

module.exports = { connectViaProxy, connectViaChain, chainHop, openSocketToProxy };
