// 產生 GitHub README banner（docs/banner.png）：品牌 relay glyph + 深色網路背景 + 標題/標語/協定 chips。
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const W = 1200, H = 340;

const chip = (x, label, fill) =>
  `<g transform="translate(${x},262)">
     <rect width="86" height="30" rx="8" fill="${fill}" fill-opacity="0.16" stroke="${fill}" stroke-opacity="0.55"/>
     <text x="43" y="20" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="${fill}">${label}</text>
   </g>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#18213b"/><stop offset="1" stop-color="#0a0f1c"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#4470c4" stop-opacity="0.55"/><stop offset="1" stop-color="#4470c4" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8fb8ff"/><stop offset="1" stop-color="#3a63b4"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- faint routing network -->
  <g stroke="#4470c4" stroke-opacity="0.16" stroke-width="1.5" fill="none">
    <path d="M60 250 L300 96 L520 205 L760 74 L980 196 L1150 108"/>
    <path d="M300 96 L520 205 L980 196"/>
    <path d="M520 205 L760 74"/>
  </g>
  <g fill="#5b86d8" fill-opacity="0.55">
    <circle cx="300" cy="96" r="4.5"/><circle cx="520" cy="205" r="4.5"/><circle cx="760" cy="74" r="4.5"/>
    <circle cx="980" cy="196" r="4.5"/><circle cx="1150" cy="108" r="4.5"/>
  </g>

  <!-- relay glyph -->
  <g transform="translate(78,80)">
    <circle cx="90" cy="90" r="150" fill="url(#glow)"/>
    <circle cx="90" cy="90" r="76" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="12"/>
    <path d="M90 14 A76 76 0 0 1 166 90" fill="none" stroke="url(#ring)" stroke-width="12" stroke-linecap="round"/>
    <path d="M14 90 A76 76 0 0 0 90 166" fill="none" stroke="#7fe3bd" stroke-width="12" stroke-linecap="round"/>
    <path d="M90 90 L90 36" stroke="#fff" stroke-width="15" stroke-linecap="round"/>
    <path d="M90 90 L144 90" stroke="#fff" stroke-width="15" stroke-linecap="round"/>
    <circle cx="90" cy="90" r="17" fill="#fff"/>
    <circle cx="90" cy="90" r="7" fill="#3a63b4"/>
  </g>

  <!-- text -->
  <text x="336" y="150" font-family="Segoe UI, Arial, sans-serif" font-size="74" font-weight="700" fill="#ffffff" letter-spacing="-1.5">RelayClient</text>
  <text x="812" y="150" font-family="Microsoft JhengHei, Segoe UI, sans-serif" font-size="34" font-weight="600" fill="#8cb0ef">代理客戶端</text>
  <text x="339" y="200" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#b3bfd9">Multi-port routing · Multi-hop chaining · Per-app TUN split · Kill-switch</text>

  ${chip(339, 'SOCKS5', '#8cb0ef')}
  ${chip(435, 'SOCKS4', '#8cb0ef')}
  ${chip(531, 'HTTP', '#7fe3bd')}
  ${chip(627, 'HTTPS', '#7fe3bd')}
  <text x="740" y="282" font-family="Segoe UI, Arial, sans-serif" font-size="15" fill="#6b7794">· open source · Windows</text>
</svg>`;

(async () => {
  const outDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'banner.png');
  await sharp(Buffer.from(SVG), { density: 144 }).png().toFile(out);
  console.log('✓ docs/banner.png');
})().catch(e => { console.error(e); process.exit(1); });
