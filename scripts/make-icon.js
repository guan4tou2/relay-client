// 從 Claude Design「App Icon」還原 app 圖示，產生 assets/icon.ico（多尺寸）+ icon.png（1024）。
// 依設計規範：>=48px 用漸層細節版；<=32px 用加粗、去中央小孔的版本，避免縮小糊成一團。
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

const ASSETS = path.join(__dirname, '..', 'assets');

const DETAILED = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b86d8"/><stop offset="1" stop-color="#3a63b4"/></linearGradient></defs>
  <rect width="256" height="256" rx="56" fill="url(#g)"/>
  <circle cx="128" cy="128" r="76" fill="none" stroke="#ffffff" stroke-opacity=".26" stroke-width="10"/>
  <path d="M128 52 A76 76 0 0 1 204 128" fill="none" stroke="#ffffff" stroke-opacity=".9" stroke-width="10" stroke-linecap="round"/>
  <path d="M52 128 A76 76 0 0 0 128 204" fill="none" stroke="#7fe3bd" stroke-width="10" stroke-linecap="round"/>
  <path d="M128 128 L128 74" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round"/>
  <path d="M128 128 L182 128" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round"/>
  <circle cx="128" cy="128" r="15" fill="#fff"/>
  <circle cx="128" cy="128" r="6" fill="#3a63b4"/>
</svg>`;

const BOLD = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="56" fill="#4470c4"/>
  <circle cx="128" cy="128" r="76" fill="none" stroke="#ffffff" stroke-opacity=".26" stroke-width="18"/>
  <path d="M128 52 A76 76 0 0 1 204 128" fill="none" stroke="#ffffff" stroke-width="18" stroke-linecap="round"/>
  <path d="M52 128 A76 76 0 0 0 128 204" fill="none" stroke="#7fe3bd" stroke-width="18" stroke-linecap="round"/>
  <path d="M128 128 L128 74" fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round"/>
  <path d="M128 128 L182 128" fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round"/>
  <circle cx="128" cy="128" r="22" fill="#fff"/>
</svg>`;

// 以目標尺寸原生渲染 SVG（避免先小圖再放大造成模糊）
async function png(svg, size) {
  const sized = svg.replace('width="256" height="256"', `width="${size}" height="${size}"`);
  return sharp(Buffer.from(sized)).png().toBuffer();
}

(async () => {
  if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await png(DETAILED, 1024));

  const spec = [[16, BOLD], [24, BOLD], [32, BOLD], [48, DETAILED], [64, DETAILED], [128, DETAILED], [256, DETAILED]];
  const buffers = [];
  for (const [s, svg] of spec) buffers.push(await png(svg, s));
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), await pngToIco(buffers));

  // 系統匣圖示：Electron 在 Windows 的 nativeImage 不會 render SVG，必須用 PNG。
  // 用品牌字符（藍＝閒置、綠＝連線中），彩色在深/淺工作列都看得見。
  const TRAY = (bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" rx="56" fill="${bg}"/>
    <circle cx="128" cy="128" r="76" fill="none" stroke="#ffffff" stroke-opacity=".28" stroke-width="18"/>
    <path d="M128 52 A76 76 0 0 1 204 128" fill="none" stroke="#ffffff" stroke-width="18" stroke-linecap="round"/>
    <path d="M52 128 A76 76 0 0 0 128 204" fill="none" stroke="#7fe3bd" stroke-width="18" stroke-linecap="round"/>
    <circle cx="128" cy="128" r="20" fill="#fff"/>
  </svg>`;
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), await png(TRAY('#4470c4'), 32));
  fs.writeFileSync(path.join(ASSETS, 'tray-active.png'), await png(TRAY('#2f9e78'), 32));

  console.log('✓ assets/icon.ico (16–256) + icon.png (1024) + tray.png/tray-active.png (32)');
})().catch(e => { console.error(e); process.exit(1); });
