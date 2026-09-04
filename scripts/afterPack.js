// electron-builder afterPack hook — 縮小體積：
//   1) 只保留必要 Electron 語系（en-US 後備 + zh-TW），刪掉其餘 ~53 個 .pak（~38MB）
//   2) 刪掉執行期用不到的 Chromium 授權文字 LICENSES.chromium.html（~9MB）
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

  console.log(`[afterPack] 移除 ${removed} 個語系 + 授權文字，釋出 ${(freed / 1024 / 1024).toFixed(1)} MB`);
};
