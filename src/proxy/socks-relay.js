const net = require('net');
const { EventEmitter } = require('events');
const { connectViaProxy, connectViaChain } = require('./connect');

class SocksRelay extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.connections = 0;
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.activeSockets = new Set();
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
    this.emit('stats', this._getStats());

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

      remoteSocket.on('data', chunk => {
        this.bytesDown += chunk.length;
        this.emit('stats', this._getStats());
      });
      clientSocket.on('data', chunk => {
        this.bytesUp += chunk.length;
        this.emit('stats', this._getStats());
      });

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
        this.emit('stats', this._getStats());
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
      this.emit('stats', this._getStats());
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
