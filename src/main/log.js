// 紀錄：記憶體緩衝（「紀錄」分頁）＋批次落地到 userData/logs/app.log。
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('../store/config');
const { send } = require('./state');

// Debug log buffer（記憶體，供「紀錄」分頁即時顯示）
const LOG_MAX = 500;
const logBuffer = [];

// 持久化紀錄：log 批次落地到 userData/logs/app.log（自動輪替；只存本機、不外流）
//
// 這裡每一個設計都是為了同一件事：relay 跑在 main process，而每條連線都會產生
// 一筆 log。舊版每筆做 existsSync + statSync + appendFileSync 三個同步 syscall，
// 實測 318µs —— 那不只是寫 log 慢，是整個事件迴圈停 318µs，連帶卡住當下所有
// 正在轉送的 socket。開一個網頁幾十條並行連線，就是十幾毫秒的主迴圈停頓。
//
//   常開 fd（省掉每筆 open/close）           318µs → 7.9µs
//   記憶體追蹤檔案大小（取代每筆 statSync）  省掉兩個 syscall
//   批次 flush（最多 LOG_PENDING_MAX 行一次）攤到每筆趨近於零
const LOG_FILE_MAX = 1024 * 1024; // 單檔上限 1 MB
const LOG_FILE_KEEP = 2;          // 保留 app.log + app.1.log
const LOG_FLUSH_MS = 150;         // 批次落地間隔
const LOG_PENDING_MAX = 256;      // 累積到這麼多行就不等計時器，直接寫
let logDir = null;
let logFilePath = null;
let logFd = null;                 // 常開的 append fd
let logSize = 0;                  // 記憶體裡追蹤的檔案大小，取代每筆 statSync
let logPending = [];              // 還沒落地的行
let logFlushTimer = null;
let logPersistDebug = false;      // 要不要把逐連線的 debug 訊息也寫進檔案

function openLogFile() {
  try {
    logSize = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
    logFd = fs.openSync(logFilePath, 'a');
  } catch (e) { logFd = null; }
}

function initFileLog() {
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, 'app.log');
    openLogFile();
    try { logPersistDebug = !!config.getSettings().logConnections; } catch (e) {}
    fileLog({ time: new Date().toISOString(), level: 'info', source: 'system',
      message: `===== 紀錄開始 v${app.getVersion()} · ${process.platform} =====` });
    flushLog();
  } catch (e) { logFilePath = null; }
}

function setLogPersistDebug(on) {
  const next = !!on;
  if (next === logPersistDebug) return;
  logPersistDebug = next;
  addLog('info', 'system', next ? '已開始把每條連線寫入紀錄檔' : '已停止把每條連線寫入紀錄檔');
}

// 換檔要先把 fd 關掉：Windows 不讓你 rename 一個還開著 handle 的檔案。
function rotateLog() {
  try { if (logFd !== null) fs.closeSync(logFd); } catch (e) {}
  logFd = null;
  try {
    for (let i = LOG_FILE_KEEP - 1; i >= 1; i--) {
      const src = i === 1 ? logFilePath : path.join(logDir, `app.${i - 1}.log`);
      const dst = path.join(logDir, `app.${i}.log`);
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch (e) {} }
    }
  } catch (e) { /* ignore */ }
  openLogFile();
}

function flushLog() {
  if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  if (!logPending.length) return;
  const chunk = logPending.join('');
  logPending = [];
  if (logFd === null) return;   // 開檔失敗 → 丟掉，不影響 app 運作
  try {
    fs.writeSync(logFd, chunk);
    logSize += Buffer.byteLength(chunk);
    if (logSize >= LOG_FILE_MAX) rotateLog();
  } catch (e) { /* 落地失敗不影響 app 運作 */ }
}

// 一筆記錄就是一行：訊息裡的換行要轉義掉。舊版沒處理，結果 stack trace 的續行
// 變成沒有時間戳的孤行，任何逐行解析都會把 "    at updateSplit (...)" 當成一筆
// 記錄、把 updateSplit 當成等級 —— 既有的 app.1.log 裡就有 6 行是這樣壞掉的。
const logOneLine = (v) => String(v).replace(/\r\n|[\r\n]/g, '\\n').replace(/\t/g, '\\t');

function fileLog(entry) {
  if (!logFilePath) return; // 尚未初始化（如測試環境）→ 不落地
  // 逐連線的 CONNECT 是 debug，預設不落地。實測使用者的紀錄檔 12038 行裡有
  // 12035 行是 CONNECT（99.98%），正常瀏覽約三天就把所有診斷訊息輪替掉了。
  if (entry.level === 'debug' && !logPersistDebug) return;
  const lvl = String(entry.level || 'info').toUpperCase().padEnd(5);
  logPending.push(`${entry.time} ${lvl} ${entry.source}: ${logOneLine(entry.message)}` +
    `${entry.detail ? ' | ' + logOneLine(entry.detail) : ''}\n`);
  if (logPending.length >= LOG_PENDING_MAX) { flushLog(); return; }
  if (!logFlushTimer) { logFlushTimer = setTimeout(flushLog, LOG_FLUSH_MS); logFlushTimer.unref(); }
}

function addLog(level, source, message, detail, meta) {
  const entry = {
    time: new Date().toISOString(),
    level,
    source,
    message,
    detail: detail || null,
    ...(meta ? { meta } : {})   // 結構化附加資料（例如命中了哪一條規則）
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  fileLog(entry);
  send('log-entry', entry);
}

// 全域例外攔截：任何未捕捉錯誤都寫進 crash log（不要讓 app 直接死）。
function writeCrashLog(tag, err) {
  try {
    const line = `${new Date().toISOString()} [${tag}] ${(err && err.stack) || err}\n`;
    require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'proxyclient-crash.log'), line);
  } catch (e) { /* ignore */ }
  try { addLog('error', 'system', `${tag}: ${(err && err.message) || err}`); } catch (e) {}
}

function registerIpc(ipcMain) {
  ipcMain.handle('get-logs', () => logBuffer);
  ipcMain.handle('clear-logs', () => { logBuffer.length = 0; return true; });
  ipcMain.handle('open-logs-folder', async () => {
    try {
      if (!logDir) return { ok: false, error: '紀錄檔尚未初始化' };
      const err = await shell.openPath(logDir);
      return err ? { ok: false, error: err } : { ok: true, path: logDir };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

// 逐一掛在 module.exports 上、不重設它：模組之間互相 require（例如 engine ↔ killswitch），
// 重設的話先載入的那一方會拿到空物件。這種寫法 TypeScript（npm run typecheck）也推得出型別。
module.exports.addLog = addLog;
module.exports.initFileLog = initFileLog;
module.exports.flushLog = flushLog;
module.exports.setLogPersistDebug = setLogPersistDebug;
module.exports.writeCrashLog = writeCrashLog;
module.exports.registerIpc = registerIpc;
