// 平台適配層（platform adapter）
//
// core（src/proxy、src/store、src/engine 的設定生成）完全不知道自己跑在哪個 OS；
// 所有「只有某個 OS 才有」的東西都收斂到這裡：
//
//   引擎          engineBinName / tunInterfaceName / selfProcessNames
//   提權          isElevated() / engineElevation
//   行程          listProcesses() / exeFilters / normalizeApp()
//   系統代理      systemProxy.{get,enable,disable}()
//   開機自啟      autostart.{get,set}()
//   收尾          killTree()
//   瀏覽器        browserCandidates()
//
// 設計上刻意讓「組指令」與「解析輸出」是純函式（xxxCommand / parseXxx），
// 這樣在 Windows 的 CI 上也能單元測試 macOS / Linux 的邏輯（見 test/platform.test.js）。

const ADAPTERS = {
  win32: () => require('./windows'),
  darwin: () => require('./darwin'),
  linux: () => require('./linux'),
};

// 取得指定平台的 adapter；測試可以用它在任一 OS 上載入任一平台實作。
function forPlatform(name) {
  const make = ADAPTERS[name];
  if (!make) throw new Error(`不支援的平台：${name}`);
  return make();
}

function isSupported(name = process.platform) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, name);
}

// 目前執行環境的 adapter。非 win/mac/linux（理論上不會發生）退回 linux，
// 讓 app 至少能跑「方式 A」（本地端口 + 串接），那部分本來就與 OS 無關。
const current = forPlatform(isSupported() ? process.platform : 'linux');

module.exports = { current, forPlatform, isSupported, PLATFORMS: Object.keys(ADAPTERS) };
