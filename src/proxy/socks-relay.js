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
      const timer = setTimeout(() => {
        socket.removeAllListeners('data');
        reject(new Error('Greeting timeout'));
        socket.destroy();
      }, 30000);
      if (timer.unref) timer.unref(); // 逾時計時器不應獨自卡住事件迴圈
      const onData = (data) => {
        clearTimeout(timer);
        if (data[0] !== 0x05) return reject(new Error('Not SOCKS5'));
        const nMethods = data[1];
        const methods = Array.from(data.slice(2, 2 + nMethods));
        resolve(methods);
      };
      socket.once('data', onData);
      socket.once('error', (err) => { clearTimeout(timer); reject(err); });
      socket.once('close', () => { clearTimeout(timer); reject(new Error('client closed before greeting')); }); // 對端關閉即清掉逾時，避免計時器殘留
    });
  }

  _readRequest(socket) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeAllListeners('data');
        reject(new Error('Request timeout'));
        socket.destroy();
      }, 30000);
      if (timer.unref) timer.unref(); // 逾時計時器不應獨自卡住事件迴圈
      const onData = (data) => {
        clearTimeout(timer);
        if (data[0] !== 0x05 || data[1] !== 0x01) {
          return reject(new Error('Unsupported SOCKS command'));
        }
        const addrType = data[3];
        let host, port, offset;

        if (addrType === 0x01) {
          host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
          offset = 8;
        } else if (addrType === 0x03) {
          const len = data[4];
          host = data.slice(5, 5 + len).toString();
          offset = 5 + len;
        } else if (addrType === 0x04) {
          const parts = [];
          for (let i = 4; i < 20; i += 2) {
            parts.push(data.readUInt16BE(i).toString(16));
          }
          host = parts.join(':');
          offset = 20;
        } else {
          return reject(new Error('Unknown address type'));
        }

        port = data.readUInt16BE(offset);
        resolve({ host, port });
      };
      socket.once('data', onData);
      socket.once('error', (err) => { clearTimeout(timer); reject(err); });
      socket.once('close', () => { clearTimeout(timer); reject(new Error('client closed before request')); }); // 對端關閉即清掉逾時，避免計時器殘留
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
