// electron-builder afterPack hook — 縮小體積：
//   1) 只保留必要 Electron 語系（en-US 後備 + zh-TW），刪掉其餘 ~53 個 .pak（~38MB）
//   2) 刪掉執行期用不到的 Chromium 授權文字 LICENSES.chromium.html（~9MB）
//   3) 刪掉只有 WebGL 才用得到的繪圖後端（~10.8MB，壓縮後約 4.8MB）
// 這些都不影響 app 功能（自訂 UI；原生對話框/托盤選單走 zh-TW）。
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const dir = context.appOutDir;
  let freed = 0;

  // 1) locales
  const keep = new Set(['en-US.pak', 'zh-TW.pak']);
  const locales = path.join(dir, 'locales');
  let removed = 0;
  try {
    for (const f of fs.readdirSync(locales)) {
      if (keep.has(f)) continue;
      const p = path.join(locales, f);
      try { freed += fs.statSync(p).size; fs.unlinkSync(p); removed++; } catch (e) {}
    }
  } catch (e) {}

  // 2) Chromium 授權 HTML
  for (const name of ['LICENSES.chromium.html', 'LICENSE.electron.txt']) {
    const p = path.join(dir, name);
    try { freed += fs.statSync(p).size; fs.unlinkSync(p); } catch (e) {}
  }

  // 3) 只有 WebGL / ANGLE 才用得到的繪圖後端。這個介面是純 2D DOM，
  //    Chromium 的 CPU 光柵化就夠了 —— 實測三個都拿掉之後：
  //      正常走 GPU                                → UI 端到端 22 項全過
  //      --disable-gpu --disable-software-rasterizer → 畫面照樣畫得出來（截圖 41KB、60 個按鈕）
  //    也就是「有顯示卡」跟「完全沒有」兩條路都驗過。
  //
  //    ffmpeg.dll 不在這個名單裡：實測拿掉之後 app 直接起不來
  //    （「找不到 ffmpeg.dll」的系統錯誤），它是 Chromium 啟動就要的。
  for (const name of ['vk_swiftshader.dll', 'vulkan-1.dll', 'd3dcompiler_47.dll']) {
    const p = path.join(dir, name);
    try { freed += fs.statSync(p).size; fs.unlinkSync(p); removed++; } catch (e) {}
  }

  console.log(`[afterPack] 移除 ${removed} 個語系/繪圖後端 + 授權文字，釋出 ${(freed / 1024 / 1024).toFixed(1)} MB`);
};
