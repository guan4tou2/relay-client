# 多端口路由（Routes）— 先以設定檔驅動（UI 之後再做）

app 啟動時會讀 `config.json` 裡的 `routes`，替每一條起一個本地 port，各自綁定你指定的
**單一 proxy 或多跳串鏈**，彼此獨立同時運作。這與主連線（10808/10809 → 當前伺服器）並存、不衝突。

## config.json 位置
```
C:\Users\<你的帳號>\AppData\Roaming\socks5-client\config.json
```
（開發模式與打包後的 exe 用同一個路徑）

> ⚠️ 編輯前請先**關閉 app**，否則存檔可能被執行中的 app 覆寫。改完存檔 → 重新開 app 生效。

## route 欄位
| 欄位 | 說明 |
|---|---|
| `id` | 唯一字串 |
| `label` | 顯示名稱（選填） |
| `localPort` | 本地監聽埠（1–65535，別和 10808/10809 或其他 route 重複） |
| `kind` | `"socks5"` 或 `"http"` |
| `hops` | `servers[].id` 的陣列，**依序**即為串鏈；長度 1 = 單跳、>1 = 多跳 proxychains |
| `enabled` | `true` / `false` |

`hops` 裡的 id 必須對應 `servers` 陣列裡某台的 `id`（找不到的 hop 會被略過並記錄 warning）。

## 範例（假設你已在 `servers` 建了一台 id = `my-proxy-1` 的上游）
把 `settings` 裡加上 `routes`：
```json
"settings": {
  "httpPort": 10808,
  "socksPort": 10809,
  "minimizeToTray": true,
  "routes": [
    { "id": "r-socks", "label": "主要 SOCKS5", "localPort": 10810, "kind": "socks5", "hops": ["my-proxy-1"], "enabled": true },
    { "id": "r-http",  "label": "主要 HTTP",   "localPort": 10811, "kind": "http",   "hops": ["my-proxy-1"], "enabled": true }
  ]
}
```
- 之後把瀏覽器/工具指到 `127.0.0.1:10810`（SOCKS5）或 `127.0.0.1:10811`（HTTP）就會走該上游。

## 多跳串鏈（proxychains 那味）
先在 app 裡把要串的每一台都建成 server，然後 `hops` 依序放它們的 id：
```json
{ "id": "r-chain", "label": "A→B→C", "localPort": 10812, "kind": "socks5",
  "hops": ["<serverA_id>", "<serverB_id>", "<serverC_id>"], "enabled": true }
```
連線路徑：`你的程式 → 127.0.0.1:10812 → A → B → C → 目標`。

## 生效 / 驗證
1. 關閉 app → 編輯 config.json → 存檔 → 重開 app。
2. 測試：`curl --socks5 127.0.0.1:10810 https://example.com`（SOCKS5 route）
   或 `curl -x 127.0.0.1:10811 https://example.com`（HTTP route）。
3. app 的「紀錄」分頁會看到 `route:<id>` 來源的連線 log。
