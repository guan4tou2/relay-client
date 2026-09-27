# QA 紀錄與尚未涵蓋的項目

最近一次全面 QA：2026-09-24（v1.3.9 之後）。所有實測都在獨立的 `--user-data-dir` 測試實例上進行，不碰使用者正在用的那顆。

## 這次實測過的

| 範圍 | 怎麼測 | 結果 |
|---|---|---|
| 伺服器新增／驗證／測試 | UI 操作；可用、連不上、不合法埠各一台 | ✅ 失敗時會寫出原因（連線被拒、逾時…） |
| 路由建立、啟停、真流量 | 本機假 SOCKS5 上游，打上百條 CONNECT | ✅ |
| 即時速率圖 60 秒／5 分鐘 | 連續 5 分鐘流量，比對速率積分與累計位元組 | ✅ 誤差 0.5%（修正後，見下） |
| 分流規則新增、模擬、三種模式 | UI 操作 + 模擬器（子網域、`=` 完全相符、內網） | ✅ |
| 匯出／匯入設定 | A 匯出 → 全新 profile 匯入 → 啟動路由打流量；另測舊格式檔 | ✅（修正後，見下） |
| 用路由開瀏覽器（實例分流） | 真的開 Chrome、看流量走路由、按兩次「結束實例」 | ✅ |
| 自動更新 | `scripts/e2e-update.js` 對安裝版 | ➖ 只驗到「已是最新版本」（見下） |
| 分流引擎（TUN） | `scripts/e2e-engine.js`，管理員實例 + 裁判 | ✅ 14/14 |
| 斷線保護 | `scripts/e2e-killswitch.js` + 自寫的連續探測 | ⚠️ 有約 5 秒外洩空窗，[#3](https://github.com/guan4tou2/relay-client/issues/3) |
| 排版 | 900×700 與最小 800×550、深淺色，每頁截圖 | ✅ |
| 單元測試／e2e-cdp | `npm test`、`scripts/e2e-cdp.js` | ✅ 359/359、22/22 |

### 這次找到並修掉的

- **匯入後路由整條不能用**：匯出檔沒帶伺服器 id，路由 hops 指向匯出端的 id。現在匯出帶 id、匯入時重新對應；舊格式檔對不回的跳點會移除並提示。
- **背景時速率放大 3 倍多**：視窗沒焦點時 Chromium 把 300ms 計時器拉長到約 1 秒，速率卻仍除以 0.3 秒；「5 分鐘」也因此涵蓋十幾分鐘。改用實際經過時間並補格。
- **重新載入後幾百 MB/s 的假尖峰**：第一筆累計位元組被當成一格的流量。
- 其餘是介面：選單寬度、分頁列跳動、toast 遮擋、最小視窗表格截斷、淺色 text3 對比（1.7 → 2.6:1）、說明文字收進 ⓘ。

### 2026-09-26 程式碼審查後修正（PR #4）

- 對比度改照 WCAG AA：淺色 text2 5.9:1、text3 4.7:1，彩色與深色主題按鈕文字都 ≥4.5:1。
- 對話框與面板：開啟時焦點移入、Tab 限制在對話框內、關閉時還原；Esc 一次只關一層。
- 以上在瀏覽器 harness（假的 `window.api`）裡以 900×700、800×550、深淺色驗證過；真 app 的 e2e-cdp 尚未重跑。

## 已知問題

- **斷線保護不是完全 fail-closed**（[#3](https://github.com/guan4tou2/relay-client/issues/3)）：sing-box 死掉時 Windows 會連 TUN 一起移除，流量退回實體網卡；封鎖模式要重建一張 TUN 才生效，實測空窗約 5 秒。README 與 RULES.md 已照實寫。

## 尚未涵蓋

| 項目 | 為什麼還沒測 | 怎麼跑 |
|---|---|---|
| 系統代理開關、規則庫真實下載 | 會寫 HKCU 登錄檔（腳本會快照並還原），要使用者本人同意 | `scripts/e2e-sysproxy-ruleset.js`，見檔頭 |
| 開機自動啟動 | 會寫 `HKCU\...\Run`（腳本會快照並還原） | `scripts/e2e-autostart.js`，見檔頭 |
| 「用到才提權」的重開流程 | 會跳 UAC，要使用者按 | `scripts/e2e-elevate.js`，見檔頭 |
| 自動更新的「有新版 → 下載」 | 安裝版 = GitHub 最新版時只驗得到「已是最新版本」 | 先裝一個比 GitHub 舊的版本，再跑 `scripts/e2e-update.js` |
| 斷線保護的外洩空窗 | 現有腳本量不到（要邊砍邊連續探測） | 修 #3 時補一個連續探測的斷言 |

## 跑引擎／斷線保護測試的前置

兩支都要管理員啟動的打包版，而且 **profile 要先放夾具**，空的 `{}` 會在第一步就失敗：

1. `npm run pack`
2. 管理員 PowerShell：建 `%TEMP%\engud\config.json`（內容 `{}`），啟動
   `dist\win-unpacked\RelayClient.exe --remote-debugging-port=9300 --user-data-dir=%TEMP%\engud`
3. 透過 CDP 在該實例建立夾具（只寫進隔離 profile）：
   - 伺服器 `127.0.0.1:11080`（socks5），路由 `id: 'r-oracle'` 指向它
   - `saveSplit({ mode: 'rule', defaultTarget: 'direct', rules: [node.exe → direct, suffix gstatic.com → r-oracle] })`
   - 第 1 條不能省：裁判自己是 node.exe，不放直連它的上游連線會被第 2 條抓回來形成迴圈
4. 一般權限：`node scripts/socks-oracle.js 11080`（裁判，記錄收到的 CONNECT）
5. 斷線保護另需第二個管理員視窗跑砍 sing-box 的小幫手（見 `scripts/e2e-killswitch.js` 檔頭）
6. `CDP_PORT=9300 node scripts/e2e-engine.js`、`CDP_PORT=9300 node scripts/e2e-killswitch.js`

結束後確認：`Get-NetAdapter` 沒有 `*proxyclient*`、沒有 `sing-box` 行程、`0.0.0.0/0` 回到原本那條。

**關測試實例只能用 PID**（找出佔著 `--remote-debugging-port` 的那個）。依視窗標題或程式名稱關，會連使用者自己的 RelayClient 一起關掉。
