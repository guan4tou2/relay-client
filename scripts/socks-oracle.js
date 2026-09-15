// 獨立的 SOCKS5 伺服器，當作「分流到底有沒有真的走代理」的裁判。
//
// 刻意不用 app 自己的 socks-relay —— 拿受測程式去驗受測程式沒有意義。
// 這支只做最小的 SOCKS5 CONNECT：收到請求就把目的地寫進日誌，然後接到真的目的地去。
// 有沒有經過代理，看日誌就知道，不必靠猜。
//
// 用法：node socks-oracle.js [port]  （預設 11080，只聽 127.0.0.1）

const net = require('net');
const fs = require('fs');

const PORT = Number(process.argv[2] || 11080);
const LOG = process.env.SOCKS_LOG || (process.env.TEMP + '/socks-oracle.log');

fs.writeFileSync(LOG, '');
const log = (s) => { const line = new Date().toISOString() + ' ' + s + '\n'; fs.appendFileSync(LOG, line); process.stdout.write(line); };

const server = net.createServer((client) => {
  client.once('data', (greeting) => {
    // 問候：VER=5, NMETHODS, METHODS...  一律回「不需認證」
    if (greeting[0] !== 0x05) { client.destroy(); return; }
    client.write(Buffer.from([0x05, 0x00]));

    client.once('data', (req) => {
      // 請求：VER CMD RSV ATYP ADDR PORT
      if (req[0] !== 0x05 || req[1] !== 0x01) {   // 只支援 CONNECT
        client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy(); return;
      }
      let host, offset;
      const atyp = req[3];
      if (atyp === 0x01) { host = Array.from(req.slice(4, 8)).join('.'); offset = 8; }
      else if (atyp === 0x03) { const len = req[4]; host = req.slice(5, 5 + len).toString(); offset = 5 + len; }
      else if (atyp === 0x04) { host = Array.from(req.slice(4, 20)).map(b => b.toString(16)).join(':'); offset = 20; }
      else { client.destroy(); return; }
      const port = req.readUInt16BE(offset);

      log(`CONNECT ${host}:${port}`);

      const upstream = net.connect(port, host, () => {
        // 成功：VER REP RSV ATYP BND.ADDR BND.PORT
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', (e) => {
        log(`FAIL ${host}:${port} ${e.code || e.message}`);
        try { client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (x) {}
        client.destroy();
      });
      client.on('error', () => upstream.destroy());
    });
  });
  client.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => log(`SOCKS5 oracle listening on 127.0.0.1:${PORT}  (log: ${LOG})`));
