const http = require('http');
const { EventEmitter } = require('events');
const { URL } = require('url');
const { connectViaProxy, connectViaChain, openSocketToProxy } = require('./connect');

// 跟 SocksRelay 同一個理由：原本每個資料 chunk 都 emit 一次，
// 那個事件在 app 裡會變成每個網路封包一次跨行程 IPC。
// 累計值漏送幾次沒有資訊損失，使用者看的是「現在多少」。
const STATS_INTERVAL_MS = 250;

class HttpBridge extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.connections = 0;
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.activeSockets = new Set();
    this._statsTimer = null;
    this._statsDirty = false;
  }

  // 資料流量：最多每 STATS_INTERVAL_MS 送一次
  _touchStats() {
    this._statsDirty = true;
    if (this._statsTimer) return;
    this._statsTimer = setTimeout(() => {
      this._statsTimer = null;
      if (!this._statsDirty) return;
      this._statsDirty = false;
      this.emit('stats', this._getStats());
    }, STATS_INTERVAL_MS);
    if (this._statsTimer.unref) this._statsTimer.unref();
  }

  // 連線數變化要馬上反映，不然按下去要等 250ms 才看到
  _flushStats() {
    this._statsDirty = false;
    if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null; }
    this.emit('stats', this._getStats());
  }

  start(localPort, upstream) {
    return new Promise((resolve, reject) => {
      // upstream 可為單一 proxy 物件，或一串 proxy 陣列（多跳串鏈）
      this.chain = Array.isArray(upstream) ? upstream : [upstream];
      this.remoteProxy = this.chain[0];

      this.server = http.createServer((req, res) => this._handleHttp(req, res));
      this.server.on('connect', (req, clientSocket, head) => this._handleConnect(req, clientSocket, head));

      this.server.on('error', err => {
        this.emit('error', err);
        try { if (this.server) this.server.close(); } catch (e) {}
        this.server = null; // 綁定失敗（如 EADDRINUSE）→ 釋出，避免殘留非監聽中的 server handle
        reject(err);
      });

      this.server.listen(localPort, '127.0.0.1', () => {
        this.emit('listening', localPort);
        resolve();
      });
    });
  }

  async _handleConnect(req, clientSocket, head) {
    this.connections++;
    this._flushStats();
    // 提早掛 error handler：await 上游期間 client 若中斷、或稍後對已關閉 socket 寫入，
    // 都不會變成未處理的 'error' 事件把整個行程帶崩。
    clientSocket.on('error', () => {});

    try {
      const [host, portStr] = req.url.split(':');
      const port = parseInt(portStr, 10) || 443;
      // debug 而非 info：這是逐連線的訊息，畫面上照常看得到，但預設不寫進紀錄檔
      this.emit('log', 'debug', `CONNECT ${host}:${port}`);

      const remoteSocket = this.chain.length > 1
        ? await connectViaChain(this.chain, { host, port })
        : await connectViaProxy(this.remoteProxy, { host, port });

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      if (head && head.length > 0) {
        remoteSocket.write(head);
        this.bytesUp += head.length;
      }

      remoteSocket.on('data', chunk => {
        this.bytesDown += chunk.length;
        this._touchStats();
      });
      clientSocket.on('data', chunk => {
        this.bytesUp += chunk.length;
        this._touchStats();
      });

      this.activeSockets.add(clientSocket);
      this.activeSockets.add(remoteSocket);

      clientSocket.pipe(remoteSocket);
      remoteSocket.pipe(clientSocket);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        this.connections = Math.max(0, this.connections - 1); // 計數永不為負（防重複遞減顯示 -1）
        this.activeSockets.delete(clientSocket);
        this.activeSockets.delete(remoteSocket);
        this._flushStats();
        clientSocket.destroy();
        remoteSocket.destroy();
      };

      clientSocket.on('close', cleanup);
      remoteSocket.on('close', cleanup);
      clientSocket.on('error', cleanup);
      remoteSocket.on('error', cleanup);

    } catch (err) {
      this.connections = Math.max(0, this.connections - 1); // 計數永不為負（防重複遞減顯示 -1）
      this._flushStats();
      this.emit('log', 'error', `CONNECT FAILED ${req.url} — ${err.message}`);
      if (!clientSocket.destroyed) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    }
  }

  async _handleHttp(req, res) {
    this.connections++;
    this._flushStats();

    // 跟 _handleConnect 同一個理由：下面要 await 上游，那期間客戶端斷線的話
    // 這兩個還沒有 error 監聽，會被升成 uncaughtException。
    req.on('error', () => {});
    if (res.socket) res.socket.on('error', () => {});

    let remoteSocket = null; // 提到 try 外，讓 catch 也能收掉上游 socket（否則洩漏）
    try {
      const url = new URL(req.url);
      const host = url.hostname;
      const port = parseInt(url.port, 10) || 80;
      this.emit('log', 'info', `${req.method} ${host}:${port}${url.pathname}`);

      let rawReq;

      if (this.chain.length > 1) {
        // 多跳串鏈：把整條鏈當成通到 origin 的隧道，送 origin-form 請求
        remoteSocket = await connectViaChain(this.chain, { host, port });
        const path = url.pathname + url.search;
        rawReq = `${req.method} ${path} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() === 'proxy-connection') continue;
          rawReq += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        rawReq += '\r\n';
      } else {
      const proxyType = this.remoteProxy.type || 'socks5';

      if (proxyType === 'http' || proxyType === 'https') {
        remoteSocket = await openSocketToProxy(this.remoteProxy, proxyType === 'https');
        rawReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() === 'proxy-connection') continue;
          rawReq += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        if (this.remoteProxy.username) {
          const cred = Buffer.from(`${this.remoteProxy.username}:${this.remoteProxy.password || ''}`).toString('base64');
          rawReq += `Proxy-Authorization: Basic ${cred}\r\n`;
        }
        rawReq += '\r\n';
      } else {
        remoteSocket = await connectViaProxy(this.remoteProxy, { host, port });
        const path = url.pathname + url.search;
        rawReq = `${req.method} ${path} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() === 'proxy-connection') continue;
          rawReq += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        rawReq += '\r\n';
      }
      }

      remoteSocket.write(rawReq);
      this.bytesUp += Buffer.byteLength(rawReq);

      req.on('data', chunk => {
        this.bytesUp += chunk.length;
        if (!remoteSocket.write(chunk)) req.pause(); // 背壓：上游寫不動就暫停讀，避免大上傳把記憶體堆爆
      });
      remoteSocket.on('drain', () => req.resume());
      req.on('error', () => { if (remoteSocket && !remoteSocket.destroyed) remoteSocket.destroy(); });

      remoteSocket.on('data', chunk => {
        this.bytesDown += chunk.length;
        this._touchStats();
      });

      this.activeSockets.add(remoteSocket);
      if (res.socket) this.activeSockets.add(res.socket);

      remoteSocket.pipe(res.socket);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        this.connections = Math.max(0, this.connections - 1); // 計數永不為負（防重複遞減顯示 -1）
        this.activeSockets.delete(remoteSocket);
        if (res.socket) this.activeSockets.delete(res.socket);
        this._flushStats();
        remoteSocket.destroy();
        if (res.socket && !res.socket.destroyed) res.socket.destroy(); // 連同 client 側一起收，避免半開洩漏
      };

      res.socket.on('close', cleanup);
      remoteSocket.on('close', cleanup);
      remoteSocket.on('error', cleanup);

    } catch (err) {
      this.connections = Math.max(0, this.connections - 1); // 計數永不為負（防重複遞減顯示 -1）
      this._flushStats();
      this.emit('log', 'error', `HTTP FAILED ${req.url} — ${err.message}`);
      if (remoteSocket) remoteSocket.destroy(); // 避免上游 socket 洩漏
      try { res.writeHead(502); res.end('Bad Gateway'); } catch (e) {}
    }
  }

  _getStats() {
    return {
      connections: this.connections,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown
    };
  }

  stop() {
    if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null; }
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
    return new Promise(resolve => {
      if (!this.server) return resolve();
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.server = null;
        this.connections = 0;
        resolve();
      };
      this.server.close(done);
      const timer = setTimeout(done, 2000);
    });
  }

  get running() {
    return this.server !== null && this.server.listening;
  }
}

module.exports = HttpBridge;
