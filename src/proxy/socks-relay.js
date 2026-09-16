const net = require('net');
const { EventEmitter } = require('events');
const { connectViaProxy, connectViaChain } = require('./connect');

// 統計事件的最小間隔。
//
// 原本是「每一個資料 chunk 都 emit 一次」，而那個事件在 app 裡會一路轉成
// webContents.send('route-stats') —— 等於每一個網路封包做一次跨行程 IPC
// 加一次結構化複製。實測 256 MB 的傳輸會送出四千多次，行程內就慢 10%，
// 跨行程的代價還在那之上。
//
// 數字本身是累計值，中間漏掉幾次完全沒有資訊損失：使用者看的是「現在多少」，
// 不是「每一個封包」。250ms 對人眼來說已經是即時。
const STATS_INTERVAL_MS = 250;

class SocksRelay extends EventEmitter {
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

  // 累計值先記著，最多每 STATS_INTERVAL_MS 送一次。
  // 計時器用 unref()：它不該讓行程因為「還有一個 timer」而不肯結束。
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

  // 連線數這種「一次一件」的變化要馬上送，不然使用者按下去要等 250ms 才看到
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
      this.server = net.createServer(socket => this._handleClient(socket));
      this.server.on('error', err => {
        this.emit('error', err);
        try { if (this.server) this.server.close(); } catch (e) {}
        this.server = null; // 綁定失敗（如 EADDRINUSE）→ 釋出，避免殘留 handle 卡住事件迴圈
        reject(err);
      });
      this.server.listen(localPort, '127.0.0.1', () => {
        this.emit('listening', localPort);
        resolve();
      });
    });
  }

  async _handleClient(clientSocket) {
    this.connections++;
    this._flushStats();

    // 一進來就先掛 error。下面每一步都有 await（讀問候、讀請求、連上游），
    // 在那期間客戶端斷線的話，這個 socket 還沒有任何 error 監聽 ——
    // Node 會把它升成 uncaughtException。實測拿瀏覽器開開關關就會看到
    // 一串 "uncaughtException: read ECONNRESET"。
    // 真正的收尾在下面的 cleanup，這裡只負責「不要炸到行程層級」。
    clientSocket.on('error', () => {});

    try {
      const authMethods = await this._readGreeting(clientSocket);
      clientSocket.write(Buffer.from([0x05, 0x00]));

      const request = await this._readRequest(clientSocket);
      const { host, port } = request;
      this.emit('log', 'info', `CONNECT ${host}:${port}`, `from ${clientSocket.remoteAddress}`);

      const remoteSocket = this.chain.length > 1
        ? await connectViaChain(this.chain, { host, port })
        : await connectViaProxy(this.chain[0], { host, port });

      const reply = Buffer.alloc(10);
      reply[0] = 0x05; // version
      reply[1] = 0x00; // success
      reply[2] = 0x00; // reserved
      reply[3] = 0x01; // IPv4
      reply.writeUInt16BE(port, 8);
      clientSocket.write(reply);

      remoteSocket.on('data', chunk => { this.bytesDown += chunk.length; this._touchStats(); });
      clientSocket.on('data', chunk => { this.bytesUp += chunk.length; this._touchStats(); });

      this.emit('log', 'info', `ESTABLISHED ${host}:${port}`);
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
        this.emit('log', 'debug', `CLOSED ${host}:${port}`);
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
      this.emit('log', 'error', `FAILED ${err.message}`);
      const errReply = Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
      clientSocket.write(errReply);
      clientSocket.destroy();
    }
  }

  _readGreeting(socket) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const cleanup = () => { clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onErr); socket.removeListener('close', onClose); };
      const timer = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error('Greeting timeout')); }, 30000);
      if (timer.unref) timer.unref(); // 逾時計時器不應獨自卡住事件迴圈
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 2) return;                          // 版本 + method 數還沒到
        if (buf[0] !== 0x05) { cleanup(); return reject(new Error('Not SOCKS5')); }
        const nMethods = buf[1];
        if (buf.length < 2 + nMethods) return;               // methods 還沒收齊 → 等下一段（分段封包）
        const methods = Array.from(buf.slice(2, 2 + nMethods));
        const leftover = buf.slice(2 + nMethods);
        cleanup();
        if (leftover.length && socket.unshift) socket.unshift(leftover); // 一起送來的 request 位元組退回，供下一次讀取
        resolve(methods);
      };
      const onErr = (err) => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error('client closed before greeting')); };
      socket.on('data', onData);   // on（非 once）→ 跨多個封包累積，避免分段時讀短
      socket.once('error', onErr);
      socket.once('close', onClose);
    });
  }

  _readRequest(socket) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const cleanup = () => { clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onErr); socket.removeListener('close', onClose); };
      const timer = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error('Request timeout')); }, 30000);
      if (timer.unref) timer.unref(); // 逾時計時器不應獨自卡住事件迴圈
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;                          // 版本/命令/保留/位址型別還沒到
        if (buf[0] !== 0x05 || buf[1] !== 0x01) { cleanup(); return reject(new Error('Unsupported SOCKS command')); }
        const addrType = buf[3];
        let host, offset;
        if (addrType === 0x01) {
          if (buf.length < 10) return;                       // IPv4(4) + port(2) → 需 10 bytes
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          offset = 8;
        } else if (addrType === 0x03) {
          if (buf.length < 5) return;
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;              // 網域(len) + port(2)
          host = buf.slice(5, 5 + len).toString();
          offset = 5 + len;
        } else if (addrType === 0x04) {
          if (buf.length < 22) return;                       // IPv6(16) + port(2)
          const parts = [];
          for (let i = 4; i < 20; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
          host = parts.join(':');
          offset = 20;
        } else {
          cleanup();
          return reject(new Error('Unknown address type'));
        }
        const port = buf.readUInt16BE(offset);
        cleanup();
        resolve({ host, port });
      };
      const onErr = (err) => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error('client closed before request')); };
      socket.on('data', onData);   // on（非 once）→ 跨多個封包累積
      socket.once('error', onErr);
      socket.once('close', onClose);
    });
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
      if (timer.unref) timer.unref(); // 後備計時器不應獨自卡住事件迴圈
    });
  }

  get running() {
    return this.server !== null && this.server.listening;
  }
}

module.exports = SocksRelay;
