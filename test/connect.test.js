const net = require('net');

jest.mock('socks', () => ({
  SocksClient: { createConnection: jest.fn() }
}));
const { SocksClient } = require('socks');

const { connectViaProxy, openSocketToProxy } = require('../src/proxy/connect');

function getRandomPort() {
  return 30000 + Math.floor(Math.random() * 20000);
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
    const port = getRandomPort();
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
    const port = getRandomPort();
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
    const port = getRandomPort();
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
    const port = getRandomPort();
    fakeProxy = net.createServer((socket) => { socket.end(); });
    await new Promise(resolve => fakeProxy.listen(port, '127.0.0.1', resolve));

    const sock = await openSocketToProxy({ host: '127.0.0.1', port }, false);
    expect(sock).toBeTruthy();
    sock.destroy();
  });

  test('rejects when proxy is unreachable', async () => {
    const port = getRandomPort();
    await expect(openSocketToProxy({ host: '127.0.0.1', port }, false))
      .rejects.toThrow(/ECONNREFUSED/);
  });
});
