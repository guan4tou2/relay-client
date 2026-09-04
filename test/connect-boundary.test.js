const { connectViaChain, connectViaProxy, chainHop } = require('../src/proxy/connect');

// 邊界 / 錯誤傳遞測試——皆走「不支援類型或空鏈」路徑，在任何 socket 連線前就拋錯，故不連網。
describe('connect.js — 串鏈邊界與錯誤處理（不連網）', () => {
  test('空鏈 → 明確錯誤', async () => {
    await expect(connectViaChain([], { host: 'x', port: 1 })).rejects.toThrow('empty proxy chain');
  });

  test('chain 非陣列 → 明確錯誤', async () => {
    await expect(connectViaChain(null, { host: 'x', port: 1 })).rejects.toThrow('empty proxy chain');
  });

  test('chainHop 不支援的 proxy 類型 → 拋錯（不嘗試連線）', async () => {
    await expect(chainHop({ type: 'quic', host: '127.0.0.1', port: 1 }, { host: 'x', port: 1 }, null))
      .rejects.toThrow('Unsupported proxy type: quic');
  });

  test('connectViaProxy 等同單跳 chainHop（不支援類型一樣拋錯）', async () => {
    await expect(connectViaProxy({ type: 'ftp', host: '127.0.0.1', port: 1 }, { host: 'x', port: 1 }))
      .rejects.toThrow('Unsupported proxy type: ftp');
  });

  test('connectViaChain 首跳失敗 → 錯誤帶跳點索引與位址（1/1）', async () => {
    await expect(connectViaChain([{ type: 'bad', host: '127.0.0.1', port: 1 }], { host: 'x', port: 1 }))
      .rejects.toThrow(/chain hop 1\/1 \(bad 127\.0\.0\.1:1\) failed: Unsupported proxy type: bad/);
  });

  test('多跳鏈首跳失敗 → 索引顯示 1/2（後續跳點不被嘗試）', async () => {
    await expect(connectViaChain(
      [{ type: 'bad', host: '127.0.0.1', port: 1 }, { type: 'socks5', host: '127.0.0.1', port: 2 }],
      { host: 'x', port: 1 }))
      .rejects.toThrow(/chain hop 1\/2/);
  });
});
