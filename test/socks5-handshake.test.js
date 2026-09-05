const net = require('net');

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

// Replicate testRawHandshake and testProxyHandshake from main.js for unit testing
function testRawHandshake(server, useTls, sendFn, validateFn) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const onConnect = () => sendFn(socket);
    let socket;
    if (useTls) {
      const tls = require('tls');
      socket = tls.connect(server.port, server.host, { rejectUnauthorized: false }, onConnect);
    } else {
      socket = net.connect(server.port, server.host, onConnect);
    }
    socket.setTimeout(10000);
    socket.once('data', (data) => {
      socket.destroy();
      try {
        validateFn(data);
        resolve(Date.now() - start);
      } catch (err) {
        reject(err);
      }
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Connection timeout')); });
    socket.once('error', (err) => { socket.destroy(); reject(err); });
  });
}

function testProxyHandshake(server) {
  const type = server.type || 'socks5';

  if (type === 'socks5') {
    return testRawHandshake(server, false, (socket) => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    }, (data) => {
      if (data[0] !== 0x05) throw new Error('Not a SOCKS5 proxy');
    });
  }

  if (type === 'socks4') {
    return testRawHandshake(server, false, (socket) => {
      socket.write(Buffer.from([0x04, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00]));
    }, (data) => {
      if (data[0] !== 0x00) throw new Error('Not a SOCKS4 proxy');
    });
  }

  if (type === 'http') {
    return testRawHandshake(server, false, (socket) => {
      socket.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n');
    }, (data) => {
      if (!data.toString().startsWith('HTTP/')) throw new Error('Not an HTTP proxy');
    });
  }

  return Promise.reject(new Error(`Unsupported proxy type: ${type}`));
}

describe('testProxyHandshake — SOCKS5', () => {
  let fakeProxy;

  afterEach((done) => {
    if (fakeProxy && fakeProxy.listening) {
      fakeProxy.close(() => { fakeProxy = null; done(); });
    } else {
      fakeProxy = null;
      done();
    }
  });

  test('succeeds when proxy replies with 0x05', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', (data) => {
        if (data[0] === 0x05) {
          socket.write(Buffer.from([0x05, 0x00]));
        }
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const latency = await testProxyHandshake({ host: '127.0.0.1', port, type: 'socks5' });
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThan(5000);
  });

  test('fails when proxy replies with non-SOCKS5', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([0x04, 0x00]));
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    await expect(testProxyHandshake({ host: '127.0.0.1', port, type: 'socks5' }))
      .rejects.toThrow('Not a SOCKS5 proxy');
  });

  test('defaults to socks5 when type is omitted', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', (data) => {
        if (data[0] === 0x05) socket.write(Buffer.from([0x05, 0x00]));
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const latency = await testProxyHandshake({ host: '127.0.0.1', port });
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  test('fails when connection is refused', async () => {
    const port = await getFreePort();
    await expect(testProxyHandshake({ host: '127.0.0.1', port, type: 'socks5' }))
      .rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('testProxyHandshake — SOCKS4', () => {
  let fakeProxy;

  afterEach((done) => {
    if (fakeProxy && fakeProxy.listening) {
      fakeProxy.close(() => { fakeProxy = null; done(); });
    } else {
      fakeProxy = null;
      done();
    }
  });

  test('succeeds when proxy replies with 0x00 0x5a', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', (data) => {
        if (data[0] === 0x04) {
          socket.write(Buffer.from([0x00, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        }
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const latency = await testProxyHandshake({ host: '127.0.0.1', port, type: 'socks4' });
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  test('fails when reply does not start with 0x00', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00]));
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    await expect(testProxyHandshake({ host: '127.0.0.1', port, type: 'socks4' }))
      .rejects.toThrow('Not a SOCKS4 proxy');
  });
});

describe('testProxyHandshake — HTTP proxy', () => {
  let fakeProxy;

  afterEach((done) => {
    if (fakeProxy && fakeProxy.listening) {
      fakeProxy.close(() => { fakeProxy = null; done(); });
    } else {
      fakeProxy = null;
      done();
    }
  });

  test('succeeds when proxy replies with HTTP status', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', (data) => {
        const str = data.toString();
        if (str.startsWith('CONNECT')) {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const latency = await testProxyHandshake({ host: '127.0.0.1', port, type: 'http' });
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  test('succeeds even with 407 response (proxy is alive)', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 407 Proxy Auth Required\r\n\r\n');
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const latency = await testProxyHandshake({ host: '127.0.0.1', port, type: 'http' });
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  test('fails when reply is not HTTP', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00]));
        socket.destroy();
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    await expect(testProxyHandshake({ host: '127.0.0.1', port, type: 'http' }))
      .rejects.toThrow('Not an HTTP proxy');
  });
});

describe('testProxyHandshake — unsupported type', () => {
  test('rejects for unknown proxy type', async () => {
    await expect(testProxyHandshake({ host: '127.0.0.1', port: 1080, type: 'unknown' }))
      .rejects.toThrow('Unsupported proxy type');
  });
});

describe('testProxyHandshake — latency measurement', () => {
  let fakeProxy;

  afterEach((done) => {
    if (fakeProxy && fakeProxy.listening) {
      fakeProxy.close(() => { fakeProxy = null; done(); });
    } else {
      fakeProxy = null;
      done();
    }
  });

  test('measures latency within reasonable range', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', () => {
        setTimeout(() => {
          socket.write(Buffer.from([0x05, 0x00]));
          socket.destroy();
        }, 50);
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const latency = await testProxyHandshake({ host: '127.0.0.1', port, type: 'socks5' });
    expect(latency).toBeGreaterThanOrEqual(40);
  });
});
