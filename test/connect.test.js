const net = require('net');

jest.mock('socks', () => ({
  SocksClient: { createConnection: jest.fn() }
}));
const { SocksClient } = require('socks');

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

describe('connectViaProxy — socks5', () => {
  beforeEach(() => SocksClient.createConnection.mockReset());

  test('calls SocksClient with type 5', async () => {
    const mockSocket = new net.Socket();
    SocksClient.createConnection.mockResolvedValue({ socket: mockSocket });

    const sock = await connectViaProxy(
      { host: '10.0.0.1', port: 1080, type: 'socks5' },
      { host: 'target.com', port: 443 }
    );
    expect(sock).toBe(mockSocket);
    const call = SocksClient.createConnection.mock.calls[0][0];
    expect(call.proxy.type).toBe(5);
    expect(call.proxy.host).toBe('10.0.0.1');
    expect(call.destination.host).toBe('target.com');
  });

  test('includes auth when username is set', async () => {
    SocksClient.createConnection.mockResolvedValue({ socket: new net.Socket() });

    await connectViaProxy(
      { host: '10.0.0.1', port: 1080, type: 'socks5', username: 'admin', password: 's3cret' },
      { host: 'x', port: 80 }
    );
    const call = SocksClient.createConnection.mock.calls[0][0];
    expect(call.proxy.userId).toBe('admin');
    expect(call.proxy.password).toBe('s3cret');
  });

  test('omits auth when no username', async () => {
    SocksClient.createConnection.mockResolvedValue({ socket: new net.Socket() });

    await connectViaProxy(
      { host: '10.0.0.1', port: 1080, type: 'socks5' },
      { host: 'x', port: 80 }
    );
    const call = SocksClient.createConnection.mock.calls[0][0];
    expect(call.proxy.userId).toBeUndefined();
  });
});

describe('connectViaProxy — socks4', () => {
  beforeEach(() => SocksClient.createConnection.mockReset());

  test('calls SocksClient with type 4', async () => {
    SocksClient.createConnection.mockResolvedValue({ socket: new net.Socket() });

    await connectViaProxy(
      { host: '10.0.0.1', port: 1080, type: 'socks4' },
      { host: 'target.com', port: 80 }
    );
    const call = SocksClient.createConnection.mock.calls[0][0];
    expect(call.proxy.type).toBe(4);
  });
});

describe('connectViaProxy — http proxy (CONNECT tunnel)', () => {
  let fakeProxy;

  afterEach((done) => {
    if (fakeProxy && fakeProxy.listening) {
      fakeProxy.close(() => { fakeProxy = null; done(); });
    } else {
      fakeProxy = null;
      done();
    }
  });

  test('establishes CONNECT tunnel on 200', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', (data) => {
        const str = data.toString();
        if (str.startsWith('CONNECT target.com:443')) {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const sock = await connectViaProxy(
      { host: '127.0.0.1', port, type: 'http' },
      { host: 'target.com', port: 443 }
    );
    expect(sock).toBeTruthy();
    sock.destroy();
  });

  test('rejects on non-200 response', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    await expect(connectViaProxy(
      { host: '127.0.0.1', port, type: 'http' },
      { host: 'target.com', port: 443 }
    )).rejects.toThrow('HTTP proxy CONNECT returned 403');
  });

  test('sends Proxy-Authorization header when auth is set', async () => {
    const port = await getFreePort();
    let receivedHeader = '';
    fakeProxy = net.createServer((socket) => {
      socket.once('data', (data) => {
        receivedHeader = data.toString();
        socket.write('HTTP/1.1 200 OK\r\n\r\n');
      });
    });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const sock = await connectViaProxy(
      { host: '127.0.0.1', port, type: 'http', username: 'user', password: 'pass' },
      { host: 'target.com', port: 443 }
    );
    expect(receivedHeader).toContain('Proxy-Authorization: Basic');
    const expected = Buffer.from('user:pass').toString('base64');
    expect(receivedHeader).toContain(expected);
    sock.destroy();
  });
});

describe('connectViaProxy — unsupported type', () => {
  test('rejects with descriptive error', async () => {
    await expect(connectViaProxy(
      { host: '1.2.3.4', port: 1080, type: 'ftp' },
      { host: 'x', port: 80 }
    )).rejects.toThrow('Unsupported proxy type: ftp');
  });
});

describe('openSocketToProxy — TCP', () => {
  let fakeProxy;

  afterEach((done) => {
    if (fakeProxy && fakeProxy.listening) {
      fakeProxy.close(() => { fakeProxy = null; done(); });
    } else {
      fakeProxy = null;
      done();
    }
  });

  test('opens TCP connection to proxy', async () => {
    const port = await getFreePort();
    fakeProxy = net.createServer((socket) => { socket.end(); });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const sock = await openSocketToProxy({ host: '127.0.0.1', port }, false);
    expect(sock).toBeTruthy();
    sock.destroy();
  });

  test('rejects when proxy is unreachable', async () => {
    const port = await getFreePort();
    await expect(openSocketToProxy({ host: '127.0.0.1', port }, false))
      .rejects.toThrow(/ECONNREFUSED/);
  });
});

// 以前三個地方都寫死 rejectUnauthorized: false：路上任何人都能冒充 HTTPS 代理，收走帳密。
describe('TLS 憑證驗證', () => {
  const tls = require('tls');
  const { EventEmitter } = require('events');
  const { openSocketToProxy, tlsOptions, explainTlsError, chainHop } = require('../src/proxy/connect');

  const fakeTlsSocket = () => {
    const s = new EventEmitter();
    s.setTimeout = jest.fn(); s.destroy = jest.fn(); s.write = jest.fn(); s.unshift = jest.fn();
    return s;
  };

  test('預設驗證；只有 tlsInsecure 才關', () => {
    expect(tlsOptions({ host: 'proxy.example.com' }).rejectUnauthorized).toBe(true);
    expect(tlsOptions({ host: 'proxy.example.com', tlsInsecure: true }).rejectUnauthorized).toBe(false);
  });

  test('網域放 servername（SNI + 驗證）；IP 不能當 SNI，改放 host 讓驗證比對 IP', () => {
    expect(tlsOptions({ host: 'proxy.example.com' })).toMatchObject({ servername: 'proxy.example.com' });
    const ip = tlsOptions({ host: '203.0.113.5' });
    expect(ip.servername).toBeUndefined();
    expect(ip.host).toBe('203.0.113.5');
  });

  test('openSocketToProxy(https) 送出去的選項有驗證憑證', async () => {
    const spy = jest.spyOn(tls, 'connect').mockImplementation((opts, cb) => { const s = fakeTlsSocket(); setImmediate(cb); return s; });
    try {
      await openSocketToProxy({ host: 'proxy.example.com', port: 8443 }, true);
      expect(spy.mock.calls[0][0]).toMatchObject({ rejectUnauthorized: true, servername: 'proxy.example.com', port: 8443 });
    } finally { spy.mockRestore(); }
  });

  test('https 跳點在通道上的 TLS 也驗證憑證', async () => {
    const spy = jest.spyOn(tls, 'connect').mockImplementation(() => {
      const s = fakeTlsSocket();
      setImmediate(() => s.emit('error', Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })));
      return s;
    });
    const upstream = fakeTlsSocket();
    try {
      await expect(chainHop({ host: 'p.example.com', port: 443, type: 'https' }, { host: 'x', port: 80 }, upstream))
        .rejects.toThrow(/略過憑證驗證/);
      expect(spy.mock.calls[0][0]).toMatchObject({ rejectUnauthorized: true, socket: upstream });
    } finally { spy.mockRestore(); }
  });

  test('憑證錯誤會附上怎麼處理；其他錯誤原樣傳回', () => {
    const e = explainTlsError(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }));
    expect(e.message).toMatch(/certificate has expired/);
    expect(e.message).toMatch(/略過憑證驗證/);
    expect(e.code).toBe('CERT_HAS_EXPIRED');
    const other = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(explainTlsError(other)).toBe(other);
  });
});
