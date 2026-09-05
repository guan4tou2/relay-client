const http = require('http');
const net = require('net');
const HttpBridge = require('../src/proxy/http-bridge');

jest.mock('../src/proxy/connect', () => ({
  connectViaProxy: jest.fn(),
  openSocketToProxy: jest.fn()
}));
const { connectViaProxy, openSocketToProxy } = require('../src/proxy/connect');

// Grab an OS-assigned free port. A fixed random range occasionally hit
// Windows reserved/excluded ports on CI (listen EACCES); asking the OS avoids that.
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

describe('HttpBridge — lifecycle', () => {
  let bridge;

  afterEach(async () => {
    if (bridge && bridge.running) await bridge.stop();
  });

  test('starts listening on specified port', async () => {
    bridge = new HttpBridge();
    const port = await getFreePort();
    await bridge.start(port, { host: '127.0.0.1', port: 1080 });
    expect(bridge.running).toBe(true);
  });

  test('emits listening event', async () => {
    bridge = new HttpBridge();
    const port = await getFreePort();
    const listening = jest.fn();
    bridge.on('listening', listening);
    await bridge.start(port, { host: '127.0.0.1', port: 1080 });
    expect(listening).toHaveBeenCalledWith(port);
  });

  test('stop resolves and clears state', async () => {
    bridge = new HttpBridge();
    const port = await getFreePort();
    await bridge.start(port, { host: '127.0.0.1', port: 1080 });
    await bridge.stop();
    expect(bridge.running).toBe(false);
    expect(bridge.server).toBeNull();
  });

  test('stop on unstarted bridge resolves', async () => {
    bridge = new HttpBridge();
    await bridge.stop();
    expect(bridge.running).toBe(false);
  });

  test('rejects on port conflict', async () => {
    bridge = new HttpBridge();
    const port = await getFreePort();
    await bridge.start(port, { host: '127.0.0.1', port: 1080 });
    const bridge2 = new HttpBridge();
    bridge2.on('error', () => {});
    await expect(bridge2.start(port, { host: '127.0.0.1', port: 1080 }))
      .rejects.toThrow(/EADDRINUSE/);
  });

  test('initial stats are zero', () => {
    bridge = new HttpBridge();
    expect(bridge.connections).toBe(0);
    expect(bridge.bytesUp).toBe(0);
    expect(bridge.bytesDown).toBe(0);
  });

  test('activeSockets starts empty', () => {
    bridge = new HttpBridge();
    expect(bridge.activeSockets.size).toBe(0);
  });
});

describe('HttpBridge — HTTPS CONNECT tunnel', () => {
  let bridge, port;

  beforeEach(async () => {
    connectViaProxy.mockReset();
    bridge = new HttpBridge();
    port = await getFreePort();
  });

  afterEach(async () => {
    if (bridge && bridge.running) await bridge.stop();
  });

  test('responds 200 on successful CONNECT', (done) => {
    const fakeRemote = new net.Socket();
    connectViaProxy.mockResolvedValue(fakeRemote);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'example.com:443'
      });

      req.on('connect', (res, socket) => {
        expect(res.statusCode).toBe(200);
        socket.destroy();
        fakeRemote.destroy();
        done();
      });

      req.on('error', () => {});
      req.end();
    });
  });

  test('responds 502 when proxy connection fails', (done) => {
    connectViaProxy.mockRejectedValue(new Error('connection refused'));

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'badhost.com:443'
      });

      req.on('connect', (res, socket) => {
        expect(res.statusCode).toBe(502);
        socket.destroy();
        done();
      });

      req.on('error', () => {});
      req.end();
    });
  });

  test('emits log on CONNECT', (done) => {
    const fakeRemote = new net.Socket();
    connectViaProxy.mockResolvedValue(fakeRemote);
    const logSpy = jest.fn();
    bridge.on('log', logSpy);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'test.com:443'
      });

      req.on('connect', (res, socket) => {
        expect(logSpy).toHaveBeenCalledWith('info', expect.stringContaining('CONNECT test.com:443'));
        socket.destroy();
        fakeRemote.destroy();
        done();
      });

      req.on('error', () => {});
      req.end();
    });
  });

  test('CONNECT defaults to port 443 when unspecified', (done) => {
    const fakeRemote = new net.Socket();
    connectViaProxy.mockResolvedValue(fakeRemote);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'secure.com'
      });

      req.on('connect', (res, socket) => {
        const dest = connectViaProxy.mock.calls[0][1];
        expect(dest.port).toBe(443);
        socket.destroy();
        fakeRemote.destroy();
        done();
      });

      req.on('error', () => {});
      req.end();
    });
  });
});

describe('HttpBridge — plain HTTP forwarding', () => {
  let bridge, port;

  beforeEach(async () => {
    connectViaProxy.mockReset();
    openSocketToProxy.mockReset();
    bridge = new HttpBridge();
    port = await getFreePort();
  });

  afterEach(async () => {
    if (bridge && bridge.running) await bridge.stop();
  });

  test('forwards GET request through SOCKS and returns response', (done) => {
    const { PassThrough } = require('stream');
    const fakeRemote = new PassThrough();
    fakeRemote.destroy = jest.fn(() => fakeRemote.end());
    connectViaProxy.mockResolvedValue(fakeRemote);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://target.com/api/test',
        headers: { 'Host': 'target.com' }
      });

      fakeRemote.on('data', (chunk) => {
        const reqStr = chunk.toString();
        if (reqStr.includes('GET /api/test')) {
          fakeRemote.push('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
          fakeRemote.push(null);
        }
      });

      req.on('error', () => {});
      req.end();

      setTimeout(() => {
        expect(connectViaProxy).toHaveBeenCalled();
        const dest = connectViaProxy.mock.calls[0][1];
        expect(dest.host).toBe('target.com');
        expect(dest.port).toBe(80);
        done();
      }, 200);
    });
  });

  test('returns 502 when plain HTTP connection fails', (done) => {
    connectViaProxy.mockRejectedValue(new Error('refused'));

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://fail.com/path'
      });
      req.on('response', (res) => {
        expect(res.statusCode).toBe(502);
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          expect(body).toBe('Bad Gateway');
          done();
        });
      });
      req.on('error', () => {});
      req.end();
    });
  });

  test('emits error log on plain HTTP failure', (done) => {
    connectViaProxy.mockRejectedValue(new Error('conn refused'));
    const logSpy = jest.fn();
    bridge.on('log', logSpy);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://fail.com/x'
      });
      req.on('response', (res) => {
        const errorCalls = logSpy.mock.calls.filter(c => c[0] === 'error');
        expect(errorCalls.length).toBeGreaterThan(0);
        expect(errorCalls[0][1]).toContain('conn refused');
        res.resume();
        done();
      });
      req.on('error', () => {});
      req.end();
    });
  });

  test('strips Proxy-Connection header from forwarded request', (done) => {
    const { PassThrough } = require('stream');
    const fakeRemote = new PassThrough();
    fakeRemote.destroy = jest.fn(() => fakeRemote.end());
    connectViaProxy.mockResolvedValue(fakeRemote);

    let captured = '';
    const origWrite = fakeRemote.write.bind(fakeRemote);
    fakeRemote.write = (chunk, ...args) => {
      captured += chunk.toString();
      return origWrite(chunk, ...args);
    };

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://target.com/',
        headers: {
          'Host': 'target.com',
          'Proxy-Connection': 'keep-alive',
          'Accept': 'text/html'
        }
      });
      req.on('error', () => {});
      req.end();

      setTimeout(() => {
        expect(captured).not.toContain('proxy-connection');
        expect(captured.toLowerCase()).not.toContain('proxy-connection');
        expect(captured).toContain('Accept');
        done();
      }, 200);
    });
  });

  test('HTTP proxy type uses openSocketToProxy and absolute URL', (done) => {
    const { PassThrough } = require('stream');
    const fakeRemote = new PassThrough();
    fakeRemote.destroy = jest.fn(() => fakeRemote.end());
    openSocketToProxy.mockResolvedValue(fakeRemote);

    let captured = '';
    const origWrite = fakeRemote.write.bind(fakeRemote);
    fakeRemote.write = (chunk, ...args) => {
      captured += chunk.toString();
      return origWrite(chunk, ...args);
    };

    bridge.start(port, { host: '10.0.0.1', port: 3128, type: 'http', username: 'admin', password: 'secret' }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://target.com/api',
        headers: { 'Host': 'target.com' }
      });
      req.on('error', () => {});
      req.end();

      setTimeout(() => {
        expect(openSocketToProxy).toHaveBeenCalledWith(
          expect.objectContaining({ host: '10.0.0.1', port: 3128, type: 'http' }),
          false
        );
        expect(connectViaProxy).not.toHaveBeenCalled();
        expect(captured).toContain('GET http://target.com/api');
        expect(captured).toContain('Proxy-Authorization: Basic');
        done();
      }, 200);
    });
  });
});

describe('HttpBridge — bytes tracking', () => {
  let port;
  beforeEach(async () => { port = await getFreePort(); });

  test('tracks upload bytes through CONNECT tunnel', (done) => {
    const bridge = new HttpBridge();
    connectViaProxy.mockReset();
    const fakeRemote = new net.Socket();
    connectViaProxy.mockResolvedValue(fakeRemote);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'x.com:443'
      });

      req.on('connect', (res, socket) => {
        const before = bridge.bytesUp;
        socket.write('HELLO');
        setTimeout(() => {
          expect(bridge.bytesUp).toBeGreaterThan(before);
          socket.destroy();
          fakeRemote.destroy();
          bridge.stop().then(done);
        }, 50);
      });

      req.on('error', () => {});
      req.end();
    });
  });

  test('tracks download bytes through CONNECT tunnel', (done) => {
    const bridge = new HttpBridge();
    connectViaProxy.mockReset();
    const { PassThrough } = require('stream');
    const fakeRemote = new PassThrough();
    fakeRemote.destroy = jest.fn(() => fakeRemote.end());
    connectViaProxy.mockResolvedValue(fakeRemote);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'x.com:443'
      });

      req.on('connect', (res, socket) => {
        const before = bridge.bytesDown;
        fakeRemote.push(Buffer.from('RESPONSE DATA'));
        setTimeout(() => {
          expect(bridge.bytesDown).toBeGreaterThan(before);
          socket.destroy();
          fakeRemote.destroy();
          bridge.stop().then(done);
        }, 50);
      });

      req.on('error', () => {});
      req.end();
    });
  });
});

describe('HttpBridge — CONNECT error log', () => {
  let port;
  beforeEach(async () => { port = await getFreePort(); });

  test('emits error log on CONNECT failure', (done) => {
    const bridge = new HttpBridge();
    connectViaProxy.mockReset();
    connectViaProxy.mockRejectedValue(new Error('proxy unreachable'));
    const logSpy = jest.fn();
    bridge.on('log', logSpy);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'fail.host:443'
      });

      req.on('connect', (res, socket) => {
        expect(res.statusCode).toBe(502);
        const errorCalls = logSpy.mock.calls.filter(c => c[0] === 'error');
        expect(errorCalls.length).toBeGreaterThan(0);
        expect(errorCalls[0][1]).toContain('CONNECT FAILED');
        expect(errorCalls[0][1]).toContain('proxy unreachable');
        socket.destroy();
        bridge.stop().then(done);
      });

      req.on('error', () => {});
      req.end();
    });
  });
});

describe('HttpBridge — stats tracking', () => {
  let port;
  beforeEach(async () => { port = await getFreePort(); });

  test('emits stats on new connection', (done) => {
    const bridge = new HttpBridge();
    const fakeRemote = new net.Socket();
    connectViaProxy.mockResolvedValue(fakeRemote);

    const statSpy = jest.fn();
    bridge.on('stats', statSpy);

    bridge.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'x.com:443'
      });

      req.on('connect', (res, socket) => {
        expect(statSpy).toHaveBeenCalled();
        const stats = statSpy.mock.calls[0][0];
        expect(stats).toHaveProperty('connections');
        expect(stats).toHaveProperty('bytesUp');
        expect(stats).toHaveProperty('bytesDown');
        socket.destroy();
        fakeRemote.destroy();
        bridge.stop().then(done);
      });

      req.on('error', () => {});
      req.end();
    });
  });
});

describe('HttpBridge — stop cleans up', () => {
  test('stop destroys tracked sockets', async () => {
    const bridge = new HttpBridge();
    const port = await getFreePort();
    const fakeRemote = new net.Socket();
    connectViaProxy.mockResolvedValue(fakeRemote);

    await bridge.start(port, { host: '127.0.0.1', port: 1080 });

    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'y.com:443'
      });

      req.on('connect', (res, socket) => {
        expect(bridge.activeSockets.size).toBeGreaterThan(0);
        resolve();
      });

      req.on('error', () => {});
      req.end();
    });

    await bridge.stop();
    expect(bridge.activeSockets.size).toBe(0);
    expect(bridge.server).toBeNull();
    expect(bridge.connections).toBe(0);
  });
});
