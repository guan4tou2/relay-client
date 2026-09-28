// 主行程各模組共用的可變狀態。
// 拆檔之前這些是 main.js 的全域變數；現在集中在這裡，誰讀誰寫一目了然。
const state = {
  mainWindow: null,
  tray: null,
  quitting: false,   // before-quit 清理中：計時器、exit 事件都不該再拉起任何東西
};

// 送訊息給主視窗（視窗還沒建、已經關掉時安靜略過）
function send(channel, payload) {
  const w = state.mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };

module.exports = { state, send, sleepSync };
