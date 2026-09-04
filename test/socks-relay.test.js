const net = require('net');
const SocksRelay = require('../src/proxy/socks-relay');

jest.mock('../src/proxy/connect', () => ({
  connectViaProxy: jest.fn(),
  openSocketToProxy: jest.fn()
}));
const { connectViaProxy } = require('../src/proxy/connect');

function getRandomPort() {
  return 30000 + Math.floor(Math.random() * 20000);
}

describe('SocksRelay — lifecycle', () => {
  let relay;

  afterEach(async () => {
    if (relay && relay.running) await relay.stop();
  });

  test('starts listening on specified port', async () => {
    relay = new SocksRelay();
    const port = getRandomPort();
    await relay.start(port, { host: '127.0.0.1', port: 1080 });
    expect(relay.running).toBe(true);
  });

  test('emits listening event', async () => {
    relay = new SocksRelay();
    const port = getRandomPort();
    const listening = jest.fn();
    relay.on('listening', listening);
    await relay.start(port, { host: '127.0.0.1', port: 1080 });
    expect(listening).toHaveBeenCalledWith(port);
  });

  test('stop resolves and sets running to false', async () => {
    relay = new SocksRelay();
    const port = getRandomPort();
    await relay.start(port, { host: '127.0.0.1', port: 1080 });
    await relay.stop();
    expect(relay.running).toBe(false);
  });

  test('stop on unstarted relay resolves immediately', async () => {
    relay = new SocksRelay();
    await relay.stop();
    expect(relay.running).toBe(false);
  });

  test('rejects on port conflict', async () => {
    relay = new SocksRelay();
    const port = getRandomPort();
    await relay.start(port, { host: '127.0.0.1', port: 1080 });
    const relay2 = new SocksRelay();
    relay2.on('error', () => {});
    await expect(relay2.start(port, { host: '127.0.0.1', port: 1080 }))
      .rejects.toThrow(/EADDRINUSE/);
  });

  test('initial stats are zero', () => {
    relay = new SocksRelay();
    expect(relay.connections).toBe(0);
    expect(relay.bytesUp).toBe(0);
    expect(relay.bytesDown).toBe(0);
  });

  test('activeSockets starts empty', () => {
    relay = new SocksRelay();
    expect(relay.activeSockets.size).toBe(0);
  });
});

describe('SocksRelay — SOCKS5 handshake', () => {
  let relay, port;

  beforeEach(async () => {
    connectViaProxy.mockReset();
    relay = new SocksRelay();
    port = getRandomPort();
  });

  afterEach(async () => {
    if (relay && relay.running) await relay.stop();
  });

  test('responds with 0x05 0x00 to valid greeting', (done) => {
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      const chunks = [];
      client.on('data', (data) => {
        chunks.push(data);
        if (chunks.length === 1) {
          expect(data[0]).toBe(0x05);
          expect(data[1]).toBe(0x00);
          client.destroy();
          remoteSocket.destroy();
          done();
        }
      });

      client.on('error', () => {});
    });
  });

  test('rejects non-SOCKS5 greeting', (done) => {
    const logSpy = jest.fn();
    relay.on('log', logSpy);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x04, 0x01, 0x00]));
      });

      client.on('data', (data) => {
        expect(data[0]).toBe(0x05);
        expect(data[1]).toBe(0x01);
        client.destroy();
        done();
      });

      client.on('error', () => {});
    });
  });

  test('parses IPv4 CONNECT request correctly', (done) => {
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', (data) => {
        phase++;
        if (phase === 1) {
          const req = Buffer.from([
            0x05, 0x01, 0x00, 0x01,
            10, 0, 0, 1,
            0x00, 0x50
          ]);
          client.write(req);
        } else if (phase === 2) {
          expect(data[0]).toBe(0x05);
          expect(data[1]).toBe(0x00);

          const dest = connectViaProxy.mock.calls[0][1];
          expect(dest.host).toBe('10.0.0.1');
          expect(dest.port).toBe(80);
          client.destroy();
          remoteSocket.destroy();
          done();
        }
      });

      client.on('error', () => {});
    });
  });

  test('parses domain CONNECT request correctly', (done) => {
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', (data) => {
        phase++;
        if (phase === 1) {
          const domain = Buffer.from('example.com');
          const req = Buffer.alloc(4 + 1 + domain.length + 2);
          req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
          req[4] = domain.length;
          domain.copy(req, 5);
          req.writeUInt16BE(443, 5 + domain.length);
          client.write(req);
        } else if (phase === 2) {
          expect(data[1]).toBe(0x00);
          const dest = connectViaProxy.mock.calls[0][1];
          expect(dest.host).toBe('example.com');
          expect(dest.port).toBe(443);
          client.destroy();
          remoteSocket.destroy();
          done();
        }
      });

      client.on('error', () => {});
    });
  });
});

describe('SocksRelay — IPv6 and edge cases', () => {
  let relay, port;

  beforeEach(async () => {
    connectViaProxy.mockReset();
    relay = new SocksRelay();
    port = getRandomPort();
  });

  afterEach(async () => {
    if (relay && relay.running) await relay.stop();
  });

  test('parses IPv6 CONNECT request correctly', (done) => {
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', (data) => {
        phase++;
        if (phase === 1) {
          const req = Buffer.alloc(4 + 16 + 2);
          req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x04;
          req[19] = 0x01;
          req.writeUInt16BE(8080, 20);
          client.write(req);
        } else if (phase === 2) {
          expect(data[1]).toBe(0x00);
          const dest = connectViaProxy.mock.calls[0][1];
          expect(dest.host).toContain('0:0:0:0:0:0:0:1');
          expect(dest.port).toBe(8080);
          client.destroy();
          remoteSocket.destroy();
          done();
        }
      });
      client.on('error', () => {});
    });
  });

  test('rejects unsupported SOCKS command (BIND=0x02)', (done) => {
    const logSpy = jest.fn();
    relay.on('log', logSpy);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', (data) => {
        phase++;
        if (phase === 1) {
          client.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]));
        } else if (phase === 2) {
          expect(data[0]).toBe(0x05);
          expect(data[1]).toBe(0x01);
          client.destroy();
          done();
        }
      });
      client.on('error', () => {});
    });
  });

  test('rejects unknown address type (0x05)', (done) => {
    const logSpy = jest.fn();
    relay.on('log', logSpy);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', (data) => {
        phase++;
        if (phase === 1) {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x05, 1, 2, 3, 4, 0x00, 0x50]));
        } else if (phase === 2) {
          expect(data[1]).toBe(0x01);
          client.destroy();
          done();
        }
      });
      client.on('error', () => {});
    });
  });

  test('emits error log when remote connection fails', (done) => {
    connectViaProxy.mockRejectedValue(new Error('SOCKS timeout'));
    const logSpy = jest.fn();
    relay.on('log', logSpy);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', (data) => {
        phase++;
        if (phase === 1) {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x50]));
        } else if (phase === 2) {
          expect(data[1]).toBe(0x01);
          const errorCalls = logSpy.mock.calls.filter(c => c[0] === 'error');
          expect(errorCalls.length).toBeGreaterThan(0);
          expect(errorCalls[0][1]).toContain('SOCKS timeout');
          client.destroy();
          done();
        }
      });
      client.on('error', () => {});
    });
  });

  test('tracks connection count correctly', (done) => {
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      expect(relay.connections).toBe(0);

      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', () => {
        phase++;
        if (phase === 1) {
          expect(relay.connections).toBeGreaterThanOrEqual(1);
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x00, 0x50]));
        } else if (phase === 2) {
          expect(relay.connections).toBe(1);
          client.destroy();
          remoteSocket.destroy();
          done();
        }
      });
      client.on('error', () => {});
    });
  });
});

describe('SocksRelay — proxy passthrough', () => {
  test('passes proxy config to connectViaProxy', (done) => {
    connectViaProxy.mockReset();
    const relay = new SocksRelay();
    const port = getRandomPort();
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: 'proxy.test', port: 9050, type: 'socks5', username: 'user', password: 'pass' }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', () => {
        phase++;
        if (phase === 1) {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x00, 0x50]));
        } else if (phase === 2) {
          const [proxy, dest] = connectViaProxy.mock.calls[0];
          expect(proxy.host).toBe('proxy.test');
          expect(proxy.port).toBe(9050);
          expect(proxy.username).toBe('user');
          expect(proxy.password).toBe('pass');
          expect(dest.host).toBe('1.1.1.1');
          expect(dest.port).toBe(80);
          client.destroy();
          remoteSocket.destroy();
          relay.stop().then(done);
        }
      });

      client.on('error', () => {});
    });
  });

  test('works with no-auth proxy', (done) => {
    connectViaProxy.mockReset();
    const relay = new SocksRelay();
    const port = getRandomPort();
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: 'proxy.test', port: 9050 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', () => {
        phase++;
        if (phase === 1) {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x00, 0x50]));
        } else if (phase === 2) {
          const [proxy] = connectViaProxy.mock.calls[0];
          expect(proxy.username).toBeUndefined();
          expect(proxy.password).toBeUndefined();
          client.destroy();
          remoteSocket.destroy();
          relay.stop().then(done);
        }
      });
      client.on('error', () => {});
    });
  });
});

describe('SocksRelay — cleanup guard', () => {
  test('connections never goes negative after socket close+error', (done) => {
    connectViaProxy.mockReset();
    const relay = new SocksRelay();
    const port = getRandomPort();
    const remoteSocket = new net.Socket();
    connectViaProxy.mockResolvedValue(remoteSocket);

    relay.start(port, { host: '127.0.0.1', port: 1080 }).then(() => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', () => {
        phase++;
        if (phase === 1) {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]));
        } else if (phase === 2) {
          expect(relay.connections).toBe(1);
          client.destroy();
          remoteSocket.destroy();
          setTimeout(() => {
            expect(relay.connections).toBe(0); // 完整生命週期後精確歸零——絕不為負（先前 -1 的 bug）
            relay.stop().then(done);
          }, 100);
        }
      });
      client.on('error', () => {});
    });
  });
});

describe('SocksRelay — stop cleans up sockets', () => {
  test('stop destroys all active sockets', async () => {
    connectViaProxy.mockReset();
    const relay = new SocksRelay();
    const port = getRandomPort();

    const remoteSocket = new net.Socket();
    const destroySpy = jest.spyOn(remoteSocket, 'destroy');
    connectViaProxy.mockResolvedValue(remoteSocket);

    await relay.start(port, { host: '127.0.0.1', port: 1080 });

    await new Promise((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let phase = 0;
      client.on('data', () => {
        phase++;
        if (phase === 1) {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]));
        } else if (phase === 2) {
          expect(relay.activeSockets.size).toBeGreaterThan(0);
          resolve();
        }
      });
      client.on('error', () => {});
    });

    await relay.stop();
    expect(relay.activeSockets.size).toBe(0);
    expect(relay.server).toBeNull();
  });
});
