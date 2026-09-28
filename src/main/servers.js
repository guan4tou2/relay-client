// 伺服器（上游代理）：CRUD、連線測試、密碼加密儲存。
const net = require('net');
const tls = require('tls');
const { safeStorage } = require('electron');
const { connectViaProxy, tlsOptions, explainTlsError } = require('../proxy/connect');
const config = require('../store/config');
const { addLog } = require('./log');
const routes = require('./routes');

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

  if (type === 'http' || type === 'https') {
    const useTls = type === 'https';
    let header = 'CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n';
    if (server.username) {
      const cred = Buffer.from(`${server.username}:${server.password || ''}`).toString('base64');
      header += `Proxy-Authorization: Basic ${cred}\r\n`;
    }
    header += '\r\n';
    return testRawHandshake(server, useTls, (socket) => {
      socket.write(header);
    }, (data) => {
      if (!data.toString().startsWith('HTTP/')) throw new Error('Not an HTTP proxy');
    });
  }

  return Promise.reject(new Error(`Unsupported proxy type: ${type}`));
}

function testRawHandshake(server, useTls, sendFn, validateFn) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const onConnect = () => sendFn(socket);
    let socket;
    if (useTls) {
      socket = tls.connect({ ...tlsOptions(server), port: server.port, host: server.host }, onConnect);
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
    socket.once('error', (err) => { socket.destroy(); reject(explainTlsError(err)); });
  });
}

// 伺服器密碼與憑證庫用 OS 的加密儲存（Windows DPAPI / macOS Keychain / Linux libsecret）。
// 只能在 app ready 之後呼叫。
function initSecretStorage() {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      addLog('warn', 'system', '這台機器不支援系統加密，伺服器密碼與憑證仍以明文存放');
      return;
    }
    // Linux 沒有 keyring 時 Electron 退回 basic_text（寫死的金鑰），等於沒有加密 —— 照實記一筆
    let backend = '';
    try { backend = safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : ''; } catch (e) {}
    if (backend === 'basic_text') addLog('warn', 'system', '找不到系統金鑰圈（keyring），密碼加密的保護力有限');
    config.setCipher({ encrypt: v => safeStorage.encryptString(v), decrypt: b => safeStorage.decryptString(b) });
    const n = config.migrateSecrets();
    if (n) addLog('info', 'system', `已把 ${n} 筆儲存的密碼改為加密存放`);
    config.getServers(); config.getCreds();   // 試解一次，看有沒有解不開的
    if (config.decryptFailures()) addLog('warn', 'system', '有儲存的密碼無法解密（設定檔可能來自另一台電腦），請重新輸入');
  } catch (e) { addLog('warn', 'system', `無法啟用密碼加密：${e.message}`); }
}

function registerIpc(ipcMain) {
  // IPC Handlers
  ipcMain.handle('get-servers', () => config.getServers());
  ipcMain.handle('get-creds', () => config.getCreds());
  ipcMain.handle('save-creds', (_e, list) => config.saveCreds(list));
  ipcMain.handle('add-server', (_e, server) => config.addServer(server));
  ipcMain.handle('update-server', (_e, id, updates) => config.updateServer(id, updates));
  ipcMain.handle('delete-server', (_e, id) => {
    config.deleteServer(id);
    return true;
  });

  ipcMain.handle('test-server', async (_e, serverId, testTarget) => {
    const server = config.getServer(serverId);
    if (!server) return { success: false, error: 'Server not found' };

    const settings = config.getSettings();
    const target = testTarget || settings.testTarget || null;
    const proxyType = server.type || 'socks5';

    const start = Date.now();
    try {
      let latency;
      if (target) {
        addLog('info', 'test', `Testing ${server.host}:${server.port} [${proxyType}] → ${target.host}:${target.port}`);
        const proxy = routes.serverToProxy(server);
        const sock = await connectViaProxy(proxy, { host: target.host, port: target.port });
        sock.destroy();
        latency = Date.now() - start;
      } else {
        addLog('info', 'test', `Testing ${proxyType} handshake ${server.host}:${server.port}`);
        latency = await testProxyHandshake(server);
      }
      config.updateServer(serverId, { latency, lastTest: Date.now(), status: 'ok', lastError: null });
      addLog('info', 'test', `SUCCESS ${server.host}:${server.port} — ${latency}ms`);
      return { success: true, latency };
    } catch (err) {
      // 失敗原因存起來：伺服器列表原本只寫「測試失敗」，看不出是被拒、逾時還是驗證錯
      config.updateServer(serverId, { latency: -1, lastTest: Date.now(), status: 'error', lastError: err.message });
      addLog('error', 'test', `FAILED ${server.host}:${server.port} — ${err.message}`);
      return { success: false, error: err.message };
    }
  });
}

// 用 Object.assign 而不是重設 module.exports：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。
Object.assign(module.exports, { initSecretStorage, registerIpc });
