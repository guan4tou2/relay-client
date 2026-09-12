const fs = require('fs');
const path = require('path');
const { HitParser } = require('../src/engine/hit-parser');

// 這份 fixture 是**真的**跑 sing-box 抓下來的 debug log：
// 用 socks inbound（免提權）＋ singbox.js 實際產生的 route.rules，
// 對 example.com（命中）／www.google.com（未命中）／blocked.test（命中封鎖）各發一次連線。
const LOG = fs.readFileSync(path.join(__dirname, 'fixtures-singbox-debug.log'), 'utf8');
// 與該次設定對應的 ruleIndex（singbox.js generateConfig 的輸出）
const RULE_INDEX = [
  { kind: 'sniff' },
  { kind: 'self' },
  { kind: 'lan' },
  { kind: 'rule', id: 'r-tw', target: 'direct' },
  { kind: 'rule', id: 'r-ex', target: 'direct' },
  { kind: 'rule', id: 'r-blk', target: 'block' },
];

function run(log, ruleIndex = RULE_INDEX) {
  const hits = [], passed = [];
  const p = new HitParser({ getRuleIndex: () => ruleIndex, onHit: h => hits.push(h) });
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!p.consume(line)) passed.push(line);
  }
  return { hits, passed, parser: p };
}

describe('命中解析器 — 對真實 sing-box debug log', () => {
  test('三條連線都解析出正確的命中結果', () => {
    const { hits } = run(LOG);
    expect(hits.map(h => [h.host, h.info ? h.info.id || h.info.kind : null])).toEqual([
      ['example.com:443', 'r-ex'],
      ['www.google.com:443', null],   // 沒有 match 行 → 未命中 → 走預設
      ['blocked.test:80', 'r-blk'],
    ]);
  });

  test('命中的規則帶得出走向', () => {
    const { hits } = run(LOG);
    expect(hits[0].info.target).toBe('direct');
    expect(hits[2].info.target).toBe('block');
  });

  test('sniff 規則不算使用者規則（match[0] 要被忽略）', () => {
    // 真實 log 裡每條連線都有 `match[0] => sniff`，但結果不能把它當成命中
    expect(LOG).toMatch(/match\[0\] => sniff/);
    const { hits } = run(LOG);
    expect(hits.every(h => !h.info || h.info.kind !== 'sniff')).toBe(true);
  });

  test('嗅探到的網域會取代 inbound 那行的目的地，並保留埠', () => {
    expect(LOG).toMatch(/sniffed protocol: tls, domain: example\.com/);
    const { hits } = run(LOG);
    expect(hits[0].host).toBe('example.com:443');
  });

  test('連線相關的行全部被消化，不會寫進 app.log', () => {
    const { passed } = run(LOG);
    for (const line of passed) {
      expect(line).not.toMatch(/inbound connection|outbound connection|router: match|sniffed protocol|connection closed/);
    }
  });

  test('放行的是啟動訊息，這些該留在紀錄裡', () => {
    const { passed } = run(LOG);
    expect(passed.some(l => /sing-box started/.test(l))).toBe(true);
  });

  test('解析完不留下未結束的連線（不會記憶體洩漏）', () => {
    const { parser } = run(LOG);
    expect(parser.pending.size).toBe(0);
  });
});

describe('命中解析器 — 邊界', () => {
  test('與連線無關的行原樣放行', () => {
    const p = new HitParser();
    expect(p.consume('INFO sing-box started (0.1s)')).toBe(false);
    expect(p.consume('FATAL something broke')).toBe(false);
  });

  test('沒有連線 ID 的行被吃掉但不產生命中', () => {
    const hits = [];
    const p = new HitParser({ onHit: h => hits.push(h) });
    expect(p.consume('router: match[3] => route(direct)')).toBe(true);
    expect(hits).toEqual([]);
  });

  test('ruleIndex 對不上（設定已重載）時當成未命中，不會炸', () => {
    const { hits } = run(LOG, []);
    expect(hits).toHaveLength(3);
    expect(hits.every(h => h.info === null)).toBe(true);
  });

  test('reset 清掉進行中的連線', () => {
    const p = new HitParser();
    p.consume('INFO [1111111 0ms] inbound/socks[in]: inbound connection to a.com:443');
    expect(p.pending.size).toBe(1);
    p.reset();
    expect(p.pending.size).toBe(0);
  });

  test('自我 bypass 的命中仍會回報，由呼叫端決定要不要計入', () => {
    const idx = [{ kind: 'self' }];
    const hits = [];
    const p = new HitParser({ getRuleIndex: () => idx, onHit: h => hits.push(h) });
    p.consume('INFO [2222222 0ms] inbound/tun[tun-in]: inbound connection to x.com:443');
    p.consume('DEBUG [2222222 1ms] router: match[0] process_name=RelayClient.exe => route(direct)');
    p.consume('INFO [2222222 1ms] outbound/direct[direct]: outbound connection to x.com:443');
    expect(hits[0].info.kind).toBe('self');
  });
});
