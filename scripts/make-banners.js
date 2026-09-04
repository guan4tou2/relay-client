// 產生 4 款不同風格的 README banner 供挑選：docs/banner-1..4.png
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const W = 1200, H = 340;

// 可重用 relay glyph（可換配色）
const glyph = (tx, ty, s, ringA, ringB, node, coreFill, faint) => `
  <g transform="translate(${tx},${ty}) scale(${s})">
    <circle cx="90" cy="90" r="76" fill="none" stroke="#ffffff" stroke-opacity="${faint}" stroke-width="12"/>
    <path d="M90 14 A76 76 0 0 1 166 90" fill="none" stroke="${ringA}" stroke-width="12" stroke-linecap="round"/>
    <path d="M14 90 A76 76 0 0 0 90 166" fill="none" stroke="${ringB}" stroke-width="12" stroke-linecap="round"/>
    <path d="M90 90 L90 36" stroke="${node}" stroke-width="15" stroke-linecap="round"/>
    <path d="M90 90 L144 90" stroke="${node}" stroke-width="15" stroke-linecap="round"/>
    <circle cx="90" cy="90" r="17" fill="${node}"/><circle cx="90" cy="90" r="7" fill="${coreFill}"/>
  </g>`;

const chip = (x, y, label, fill) =>
  `<g transform="translate(${x},${y})"><rect width="86" height="30" rx="8" fill="${fill}" fill-opacity="0.16" stroke="${fill}" stroke-opacity="0.55"/><text x="43" y="20" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="${fill}">${label}</text></g>`;

const F = 'Segoe UI, Arial, sans-serif';
const CF = 'Microsoft JhengHei, Segoe UI, sans-serif';

// ---------- 1) Network Flow（深色 + 路由網路 + 徽章）----------
const v1 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#18213b"/><stop offset="1" stop-color="#0a0f1c"/></linearGradient>
    <radialGradient id="g1" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#4470c4" stop-opacity=".55"/><stop offset="1" stop-color="#4470c4" stop-opacity="0"/></radialGradient>
    <linearGradient id="r1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb8ff"/><stop offset="1" stop-color="#3a63b4"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg1)"/>
  <g stroke="#4470c4" stroke-opacity=".14" stroke-width="1.5" fill="none">
    <path d="M60 250 L300 96 L520 205 L760 74 L980 196 L1150 108"/><path d="M300 96 L520 205 L980 196"/><path d="M520 205 L760 74"/></g>
  <path d="M300 96 L520 205 L760 74 L980 196" stroke="#7fe3bd" stroke-opacity=".5" stroke-width="2.5" fill="none"/>
  <g fill="#5b86d8"><circle cx="300" cy="96" r="5"/><circle cx="520" cy="205" r="5"/><circle cx="760" cy="74" r="5"/><circle cx="980" cy="196" r="5"/><circle cx="1150" cy="108" r="5"/></g>
  <circle cx="168" cy="170" r="150" fill="url(#g1)"/>
  ${glyph(78, 80, 1, 'url(#r1)', '#7fe3bd', '#fff', '#3a63b4', '.22')}
  <text x="336" y="150" font-family="${F}" font-size="74" font-weight="700" fill="#fff" letter-spacing="-1.5">RelayClient</text>
  <text x="812" y="150" font-family="${CF}" font-size="34" font-weight="600" fill="#8cb0ef">代理客戶端</text>
  <text x="339" y="200" font-family="${F}" font-size="22" fill="#b3bfd9">Multi-port routing · Multi-hop chaining · Per-app TUN split · Kill-switch</text>
  ${chip(339, 262, 'SOCKS5', '#8cb0ef')}${chip(435, 262, 'SOCKS4', '#8cb0ef')}${chip(531, 262, 'HTTP', '#7fe3bd')}${chip(627, 262, 'HTTPS', '#7fe3bd')}
  <text x="742" y="282" font-family="${F}" font-size="15" fill="#6b7794">· open source · MIT · Windows</text>
</svg>`;

// ---------- 2) Blue Gradient Hero（品牌藍漸層）----------
const v2 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b86d8"/><stop offset=".55" stop-color="#3f66bd"/><stop offset="1" stop-color="#2a4a8f"/></linearGradient>
    <radialGradient id="g2" cx=".2" cy=".1" r=".9"><stop offset="0" stop-color="#ffffff" stop-opacity=".18"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg2)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>
  <g stroke="#ffffff" stroke-opacity=".14" stroke-width="1.5" fill="none"><path d="M0 300 L280 150 L520 250 L820 120 L1200 240"/></g>
  <g fill="#ffffff" fill-opacity=".5"><circle cx="280" cy="150" r="4"/><circle cx="520" cy="250" r="4"/><circle cx="820" cy="120" r="4"/></g>
  ${glyph(84, 84, .95, '#ffffff', '#bfffe6', '#ffffff', '#2a4a8f', '.30')}
  <text x="330" y="152" font-family="${F}" font-size="76" font-weight="800" fill="#ffffff" letter-spacing="-2">RelayClient</text>
  <text x="826" y="152" font-family="${CF}" font-size="34" font-weight="600" fill="#dbe6ff">代理客戶端</text>
  <text x="333" y="202" font-family="${F}" font-size="22" fill="#e6eeff">Multi-port routing · Multi-hop chaining · Per-app TUN split · Kill-switch</text>
  ${chip(333, 262, 'SOCKS5', '#ffffff')}${chip(429, 262, 'SOCKS4', '#ffffff')}${chip(525, 262, 'HTTP', '#bfffe6')}${chip(621, 262, 'HTTPS', '#bfffe6')}
  <text x="736" y="282" font-family="${F}" font-size="15" fill="#cfe0ff">· open source · Windows</text>
</svg>`;

// ---------- 3) Routing Diagram Hero（把「串鏈」畫出來）----------
const node3 = (x, label, sub, fill) => `
  <g transform="translate(${x},188)">
    <circle cx="0" cy="0" r="26" fill="#141c30" stroke="${fill}" stroke-width="2.5"/>
    <text x="0" y="6" text-anchor="middle" font-family="${F}" font-size="18" font-weight="700" fill="${fill}">${label}</text>
    <text x="0" y="52" text-anchor="middle" font-family="${F}" font-size="14" fill="#8291b0">${sub}</text>
  </g>`;
const v3 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#151d33"/><stop offset="1" stop-color="#090d18"/></linearGradient>
  <linearGradient id="r3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb8ff"/><stop offset="1" stop-color="#3a63b4"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg3)"/>
  ${glyph(46, 40, .62, 'url(#r3)', '#7fe3bd', '#fff', '#3a63b4', '.22')}
  <text x="196" y="86" font-family="${F}" font-size="46" font-weight="700" fill="#fff" letter-spacing="-1">RelayClient</text>
  <text x="196" y="120" font-family="${CF}" font-size="21" font-weight="600" fill="#8cb0ef">代理客戶端 · per-app proxy routing &amp; chaining</text>
  <g stroke="#4470c4" stroke-width="2.5" fill="none" stroke-dasharray="1 0">
    <path d="M186 188 L300 188"/><path d="M352 188 L470 188"/><path d="M522 188 L640 188"/><path d="M692 188 L810 188"/><path d="M862 188 L980 188"/></g>
  <g fill="#7fe3bd"><polygon points="300,183 310,188 300,193"/><polygon points="470,183 480,188 470,193"/><polygon points="640,183 650,188 640,193"/><polygon points="810,183 820,188 810,193"/><polygon points="980,183 990,188 980,193"/></g>
  ${node3(160, 'App', 'chrome.exe', '#8cb0ef')}
  ${node3(326, '⬡', 'RelayClient', '#7fe3bd')}
  ${node3(496, 'A', 'hop 1', '#8cb0ef')}
  ${node3(666, 'B', 'hop 2', '#8cb0ef')}
  ${node3(836, '◍', 'exit', '#8cb0ef')}
  <text x="1006" y="194" font-family="${F}" font-size="18" fill="#b3bfd9">🌐 Internet</text>
  <text x="196" y="300" font-family="${F}" font-size="16" fill="#6b7794">SOCKS5 · SOCKS4 · HTTP · HTTPS   ·   fail-closed kill-switch   ·   open source</text>
</svg>`;

// ---------- 4) Minimal Dark（點陣 + 大量留白）----------
let dots = '';
for (let y = 40; y < H; y += 34) for (let x = 40; x < W; x += 34) dots += `<circle cx="${x}" cy="${y}" r="1.5" fill="#31406a" fill-opacity=".5"/>`;
const v4 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="g4" cx=".16" cy=".5" r=".5"><stop offset="0" stop-color="#4470c4" stop-opacity=".4"/><stop offset="1" stop-color="#4470c4" stop-opacity="0"/></radialGradient>
  <linearGradient id="r4" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb8ff"/><stop offset="1" stop-color="#3a63b4"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="#0b0f1a"/><g>${dots}</g><circle cx="190" cy="170" r="150" fill="url(#g4)"/>
  ${glyph(100, 80, 1, 'url(#r4)', '#7fe3bd', '#fff', '#3a63b4', '.2')}
  <text x="360" y="158" font-family="${F}" font-size="70" font-weight="700" fill="#fff" letter-spacing="-1.5">RelayClient</text>
  <circle cx="372" cy="196" r="4" fill="#7fe3bd"/>
  <text x="388" y="202" font-family="${F}" font-size="20" fill="#9fb0d0">代理客戶端 — proxy routing · chaining · per-app split</text>
</svg>`;

(async () => {
  const dir = path.join(__dirname, '..', 'docs'); fs.mkdirSync(dir, { recursive: true });
  const variants = { 'banner-1.png': v1, 'banner-2.png': v2, 'banner-3.png': v3, 'banner-4.png': v4 };
  for (const [name, svg] of Object.entries(variants)) {
    await sharp(Buffer.from(svg), { density: 144 }).png().toFile(path.join(dir, name));
    console.log('✓ docs/' + name);
  }
})().catch(e => { console.error(e); process.exit(1); });
