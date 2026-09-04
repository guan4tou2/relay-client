const http = require('http');
const { EventEmitter } = require('events');
const { URL } = require('url');
const { connectViaProxy, connectViaChain, openSocketToProxy } = require('./connect');

class HttpBridge extends EventEmitter {
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

      this.server = http.createServer((req, res) => this._handleHttp(req, res));
      this.server.on('connect', (req, clientSocket, head) => this._handleConnect(req, clientSocket, head));

      this.server.on('error', err => {
        this.emit('error', err);
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
    this.emit('stats', this._getStats());

    try {
      const [host, portStr] = req.url.split(':');
      const port = parseInt(portStr, 10) || 443;
      this.emit('log', 'info', `CONNECT ${host}:${port}`);

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
        this.emit('stats', this._getStats());
      });
      clientSocket.on('data', chunk => {
        this.bytesUp += chunk.length;
        this.emit('stats', this._getStats());
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
        this.emit('stats', this._getStats());
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
      this.emit('log', 'error', `CONNECT FAILED ${req.url} — ${err.message}`);
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    }
  }

  async _handleHttp(req, res) {
    this.connections++;
    this.emit('stats', this._getStats());

    try {
      const url = new URL(req.url);
      const host = url.hostname;
      const port = parseInt(url.port, 10) || 80;
      this.emit('log', 'info', `${req.method} ${host}:${port}${url.pathname}`);

      let remoteSocket;
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
        remoteSocket.write(chunk);
        this.bytesUp += chunk.length;
      });

      remoteSocket.on('data', chunk => {
        this.bytesDown += chunk.length;
        this.emit('stats', this._getStats());
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
        this.emit('stats', this._getStats());
        remoteSocket.destroy();
      };

      res.socket.on('close', cleanup);
      remoteSocket.on('close', cleanup);
      remoteSocket.on('error', cleanup);

    } catch (err) {
      this.connections = Math.max(0, this.connections - 1); // 計數永不為負（防重複遞減顯示 -1）
      this.emit('stats', this._getStats());
      this.emit('log', 'error', `HTTP FAILED ${req.url} — ${err.message}`);
      res.writeHead(502);
      res.end('Bad Gateway');
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
